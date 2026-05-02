import type { Env } from "../../../env"
import type { LinkSummaryProviderResult } from "./types"

function trimEnv(value: string | undefined): string {
  return String(value || "").trim()
}

function normalizeMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content
  }
  if (!Array.isArray(content)) {
    return ""
  }
  return content
    .filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text")
    .map((part) => String((part as { text?: string }).text ?? ""))
    .join("")
}

function cleanText(value: unknown): string {
  if (typeof value !== "string") {
    return ""
  }
  return value.replace(/\s+/g, " ").trim()
}

function requireMaxLength(value: string, maxLength: number, fieldName: string): void {
  if (value.length > maxLength) {
    throw new Error(`OpenRouter link summary response schema mismatch: ${fieldName} too long`)
  }
}

function validateSummaryResponse(value: unknown): {
  summary_paragraph: string
  short_summary: string
  key_points: string[]
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenRouter link summary response schema mismatch: expected object")
  }

  const parsed = value as Record<string, unknown>
  const summaryParagraph = cleanText(parsed.summary_paragraph)
  const shortSummary = cleanText(parsed.short_summary)
  const keyPoints = Array.isArray(parsed.key_points)
    ? parsed.key_points
      .map((point) => cleanText(point))
      .filter(Boolean)
      .slice(0, 3)
    : []

  if (!summaryParagraph) {
    throw new Error("OpenRouter link summary response schema mismatch: invalid summary_paragraph")
  }
  if (!shortSummary) {
    throw new Error("OpenRouter link summary response schema mismatch: invalid short_summary")
  }
  if (keyPoints.length !== 3) {
    throw new Error("OpenRouter link summary response schema mismatch: expected exactly three key_points")
  }
  requireMaxLength(summaryParagraph, 1_600, "summary_paragraph")
  requireMaxLength(shortSummary, 220, "short_summary")
  for (const point of keyPoints) {
    requireMaxLength(point, 72, "key_points")
  }

  return {
    summary_paragraph: summaryParagraph,
    short_summary: shortSummary,
    key_points: keyPoints,
  }
}

function buildSourceText(input: {
  title: string | null
  publisher: string | null
  publishedAt: string | null
  markdown: string
}): string {
  const markdown = input.markdown.replace(/\s+/g, " ").trim().slice(0, 16_000)
  return JSON.stringify({
    title: input.title,
    publisher: input.publisher,
    published_at: input.publishedAt,
    article_markdown: markdown,
  })
}

export async function requestLinkSummary(input: {
  env: Env
  title: string | null
  publisher: string | null
  publishedAt: string | null
  markdown: string
  fetcher?: typeof fetch
}): Promise<LinkSummaryProviderResult> {
  const apiKey = trimEnv(input.env.OPENROUTER_API_KEY)
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured")
  }

  const baseUrl = trimEnv(input.env.OPENROUTER_BASE_URL) || "https://openrouter.ai/api/v1"
  const model = trimEnv(input.env.OPENROUTER_LINK_SUMMARY_MODEL)
    || trimEnv(input.env.OPENROUTER_MODEL)
    || "google/gemini-2.5-flash-lite-preview-09-2025"
  const timeoutMs = Number.parseInt(
    trimEnv(input.env.OPENROUTER_LINK_SUMMARY_TIMEOUT_MS) || trimEnv(input.env.OPENROUTER_TIMEOUT_MS),
    10,
  )
  const controller = new AbortController()
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null

  try {
    const response = await (input.fetcher ?? fetch)(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_completion_tokens: 512,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "link_article_summary",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["summary_paragraph", "short_summary", "key_points"],
              properties: {
                summary_paragraph: { type: "string", maxLength: 1_600 },
                short_summary: { type: "string", maxLength: 220 },
                key_points: {
                  type: "array",
                  minItems: 3,
                  maxItems: 3,
                  items: { type: "string", maxLength: 72 },
                },
              },
            },
          },
        },
        messages: [
          {
            role: "system",
            content:
              "Summarize the supplied article in a neutral, source-grounded voice. " +
              "Do not add facts, context, accusations, or conclusions that are not in the article. " +
              "Separate reported claims from confirmed events when the article does. " +
              "Avoid loaded language and keep attribution clear. " +
              "Return exactly three short scan bullets and one short paragraph. " +
              "Bullets are for quick digestion: each one must be a headline fragment of 3-8 words, 72 characters or less. " +
              "Do not write bullet sentences, clauses, explanations, or duplicate sentence-length details. " +
              "Good bullet style: 'Ships seized off Greece', 'Israel cites naval blockade', 'Turkey condemns interception'. " +
              "The short_summary field must be one neutral sentence of 30 words or fewer. " +
              "The summary_paragraph field may contain the fuller neutral article summary. " +
              "Use the paragraph for detail; do not duplicate the full paragraph in the bullets.",
          },
          {
            role: "user",
            content: buildSourceText({
              title: input.title,
              publisher: input.publisher,
              publishedAt: input.publishedAt,
              markdown: input.markdown,
            }),
          },
        ],
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`OpenRouter link summary request failed with http_${response.status}`)
    }

    const body = await response.json().catch(() => null) as
      | {
          choices?: Array<{ message?: { content?: unknown } }>
        }
      | null
    if (!body) {
      throw new Error("OpenRouter link summary response was not valid JSON")
    }

    const normalizedContent = normalizeMessageContent(body.choices?.[0]?.message?.content)
    if (!normalizedContent.trim()) {
      throw new Error("OpenRouter link summary response was empty")
    }

    const parsed = validateSummaryResponse(JSON.parse(normalizedContent))

    return {
      provider: "openrouter",
      model,
      summaryParagraph: parsed.summary_paragraph,
      shortSummary: parsed.short_summary,
      keyPoints: parsed.key_points,
      providerResult: body as Record<string, unknown>,
    }
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
