import type { Env } from "../../../env"
import { normalizeContentLocale } from "../../localization/content-locale"
import {
  firstTrimmedEnv,
  parsePositiveIntegerEnv,
  requestOpenRouterChatCompletion,
  DEFAULT_OPENROUTER_MODEL,
} from "../../openrouter-client"
import {
  cleanNullableProviderText,
  parseProviderKeyPoints,
} from "./provider-validation"
import type { LinkSummaryTranslationProviderResult } from "./types"

const TRANSLATION_RESPONSE_ERROR_PREFIX = "OpenRouter link summary translation response schema mismatch"

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

  return {
    target_locale: parsedLocale,
    title: cleanNullableProviderText(parsed.title),
    description: cleanNullableProviderText(parsed.description),
    summary_paragraph: cleanNullableProviderText(parsed.summary_paragraph),
    short_summary: cleanNullableProviderText(parsed.short_summary),
    key_points: parseProviderKeyPoints({
      value: parsed.key_points,
      maxLength: 96,
      errorPrefix: TRANSLATION_RESPONSE_ERROR_PREFIX,
    }),
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

  const apiKey = firstTrimmedEnv(input.env.OPENROUTER_API_KEY)
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured")
  }

  const model = firstTrimmedEnv(
    input.env.OPENROUTER_LINK_SUMMARY_TRANSLATION_MODEL,
    input.env.OPENROUTER_TRANSLATION_MODEL,
    input.env.OPENROUTER_MODEL,
  )
    || DEFAULT_OPENROUTER_MODEL
  const timeoutMs = parsePositiveIntegerEnv(firstTrimmedEnv(
    input.env.OPENROUTER_LINK_SUMMARY_TRANSLATION_TIMEOUT_MS,
    input.env.OPENROUTER_TIMEOUT_MS,
  ))

  const { body, content } = await requestOpenRouterChatCompletion({
    apiKey,
    baseUrl: input.env.OPENROUTER_BASE_URL,
    errorLabel: "link summary translation",
    fetcher: input.fetcher,
    timeoutMs,
    body: {
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
    },
  })

  const parsed = validateTranslationResponse(JSON.parse(content), targetLocale)
  return {
    provider: "openrouter",
    model,
    locale: parsed.target_locale,
    title: parsed.title,
    description: parsed.description,
    summaryParagraph: parsed.summary_paragraph,
    shortSummary: parsed.short_summary,
    keyPoints: parsed.key_points,
    providerResult: body,
  }
}
