import type { Env } from "../../../env"
import {
  firstTrimmedEnv,
  parsePositiveIntegerEnv,
  requestOpenRouterChatCompletion,
} from "../../openrouter-client"
import {
  cleanProviderText,
  parseProviderKeyPoints,
  requireProviderMaxLength,
} from "./provider-validation"
import type { LinkSummaryProviderResult } from "./types"

const SUMMARY_RESPONSE_ERROR_PREFIX = "OpenRouter link summary response schema mismatch"

function validateSummaryResponse(value: unknown): {
  summary_paragraph: string
  short_summary: string
  key_points: string[]
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenRouter link summary response schema mismatch: expected object")
  }

  const parsed = value as Record<string, unknown>
  const summaryParagraph = cleanProviderText(parsed.summary_paragraph)
  const shortSummary = cleanProviderText(parsed.short_summary)

  if (!summaryParagraph) {
    throw new Error("OpenRouter link summary response schema mismatch: invalid summary_paragraph")
  }
  if (!shortSummary) {
    throw new Error("OpenRouter link summary response schema mismatch: invalid short_summary")
  }
  requireProviderMaxLength({
    value: summaryParagraph,
    maxLength: 1_600,
    fieldName: "summary_paragraph",
    errorPrefix: SUMMARY_RESPONSE_ERROR_PREFIX,
  })
  requireProviderMaxLength({
    value: shortSummary,
    maxLength: 220,
    fieldName: "short_summary",
    errorPrefix: SUMMARY_RESPONSE_ERROR_PREFIX,
  })

  return {
    summary_paragraph: summaryParagraph,
    short_summary: shortSummary,
    key_points: parseProviderKeyPoints({
      value: parsed.key_points,
      maxLength: 72,
      errorPrefix: SUMMARY_RESPONSE_ERROR_PREFIX,
    }),
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
  const apiKey = firstTrimmedEnv(input.env.OPENROUTER_API_KEY)
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured")
  }

  const model = firstTrimmedEnv(
    input.env.OPENROUTER_LINK_SUMMARY_MODEL,
    input.env.OPENROUTER_MODEL,
  )
    || "google/gemini-2.5-flash-lite-preview-09-2025"
  const timeoutMs = parsePositiveIntegerEnv(firstTrimmedEnv(
    input.env.OPENROUTER_LINK_SUMMARY_TIMEOUT_MS,
    input.env.OPENROUTER_TIMEOUT_MS,
  ))

  const { body, content } = await requestOpenRouterChatCompletion({
    apiKey,
    baseUrl: input.env.OPENROUTER_BASE_URL,
    errorLabel: "link summary",
    fetcher: input.fetcher,
    timeoutMs,
    body: {
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
    },
  })

  const parsed = validateSummaryResponse(JSON.parse(content))

  return {
    provider: "openrouter",
    model,
    summaryParagraph: parsed.summary_paragraph,
    shortSummary: parsed.short_summary,
    keyPoints: parsed.key_points,
    providerResult: body,
  }
}
