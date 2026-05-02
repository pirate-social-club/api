import type { Env } from "../../../env"
import { normalizeContentLocale } from "../../localization/content-locale"
import type { LinkSummaryTranslationProviderResult } from "./types"

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

function cleanNullableText(value: unknown): string | null {
  const cleaned = cleanText(value)
  return cleaned || null
}

function validateTranslationResponse(value: unknown, targetLocale: string): {
  target_locale: string
  title: string | null
  description: string | null
  summary_paragraph: string | null
  short_summary: string | null
  key_points: string[]
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenRouter link summary translation response schema mismatch: expected object")
  }

  const parsed = value as Record<string, unknown>
  const parsedLocale = normalizeContentLocale(typeof parsed.target_locale === "string" ? parsed.target_locale : null)
  if (!parsedLocale || parsedLocale !== targetLocale) {
    throw new Error("OpenRouter link summary translation response schema mismatch: target_locale mismatch")
  }

  const keyPoints = Array.isArray(parsed.key_points)
    ? parsed.key_points.map(cleanText).filter(Boolean)
    : []
  if (keyPoints.length !== 3) {
    throw new Error("OpenRouter link summary translation response schema mismatch: expected exactly three key_points")
  }
  for (const point of keyPoints) {
    if (point.length > 96) {
      throw new Error("OpenRouter link summary translation response schema mismatch: key_points too long")
    }
  }

  return {
    target_locale: parsedLocale,
    title: cleanNullableText(parsed.title),
    description: cleanNullableText(parsed.description),
    summary_paragraph: cleanNullableText(parsed.summary_paragraph),
    short_summary: cleanNullableText(parsed.short_summary),
    key_points: keyPoints,
  }
}

export async function requestLinkSummaryTranslation(input: {
  env: Env
  targetLocale: string
  title: string | null
  description: string | null
  summaryParagraph: string | null
  shortSummary: string | null
  keyPoints: string[]
  fetcher?: typeof fetch
}): Promise<LinkSummaryTranslationProviderResult> {
  const targetLocale = normalizeContentLocale(input.targetLocale)
  if (!targetLocale) {
    throw new Error("Invalid target locale for link summary translation")
  }

  const apiKey = trimEnv(input.env.OPENROUTER_API_KEY)
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured")
  }

  const baseUrl = trimEnv(input.env.OPENROUTER_BASE_URL) || "https://openrouter.ai/api/v1"
  const model = trimEnv(input.env.OPENROUTER_LINK_SUMMARY_TRANSLATION_MODEL)
    || trimEnv(input.env.OPENROUTER_TRANSLATION_MODEL)
    || trimEnv(input.env.OPENROUTER_MODEL)
    || "google/gemini-2.5-flash-lite-preview-09-2025"
  const timeoutMs = Number.parseInt(
    trimEnv(input.env.OPENROUTER_LINK_SUMMARY_TRANSLATION_TIMEOUT_MS) || trimEnv(input.env.OPENROUTER_TIMEOUT_MS),
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
        max_completion_tokens: 700,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "link_article_summary_translation",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: ["target_locale", "title", "description", "summary_paragraph", "short_summary", "key_points"],
              properties: {
                target_locale: { type: "string" },
                title: { type: ["string", "null"], maxLength: 240 },
                description: { type: ["string", "null"], maxLength: 360 },
                summary_paragraph: { type: ["string", "null"], maxLength: 1_800 },
                short_summary: { type: ["string", "null"], maxLength: 260 },
                key_points: {
                  type: "array",
                  minItems: 3,
                  maxItems: 3,
                  items: { type: "string", maxLength: 96 },
                },
              },
            },
          },
        },
        messages: [
          {
            role: "system",
            content:
              "Translate the supplied article card fields into the requested locale. " +
              "Preserve meaning, attribution, numbers, dates, and names. Do not add facts or commentary. " +
              "Keep the three key_points as short scan bullets, not full explanatory sentences. " +
              "Return null only for fields that are null in the source. Return exactly three key_points.",
          },
          {
            role: "user",
            content: JSON.stringify({
              target_locale: targetLocale,
              title: input.title,
              description: input.description,
              summary_paragraph: input.summaryParagraph,
              short_summary: input.shortSummary,
              key_points: input.keyPoints.slice(0, 3),
            }),
          },
        ],
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`OpenRouter link summary translation request failed with http_${response.status}`)
    }

    const body = await response.json().catch(() => null) as
      | {
          choices?: Array<{ message?: { content?: unknown } }>
        }
      | null
    if (!body) {
      throw new Error("OpenRouter link summary translation response was not valid JSON")
    }

    const normalizedContent = normalizeMessageContent(body.choices?.[0]?.message?.content)
    if (!normalizedContent.trim()) {
      throw new Error("OpenRouter link summary translation response was empty")
    }

    const parsed = validateTranslationResponse(JSON.parse(normalizedContent), targetLocale)
    return {
      provider: "openrouter",
      model,
      locale: parsed.target_locale,
      title: parsed.title,
      description: parsed.description,
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
