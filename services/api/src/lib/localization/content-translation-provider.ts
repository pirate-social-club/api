import type { Env } from "../../env"
import {
  firstTrimmedEnv,
  parsePositiveIntegerEnv,
  requestOpenRouterChatCompletion,
} from "../openrouter-client"
import { normalizeContentLocale } from "./content-locale"
import { missingTranslatedContentField } from "./content-translation-validation"

export type ContentTranslationProviderResult = {
  provider: "openrouter"
  model: string
  sourceLanguage: string
  targetLocale: string
  outcome: "translated" | "same_language"
  translatedTitle: string | null
  translatedBody: string | null
  translatedCaption: string | null
  providerResult: Record<string, unknown> | null
}

type ParsedContentTranslation = {
  source_language: string
  target_locale: string
  outcome: "translated" | "same_language"
  translated_title: string | null
  translated_body: string | null
  translated_caption: string | null
}

const DEFAULT_TRANSLATION_MAX_COMPLETION_TOKENS = 1_024
const MIN_TRANSLATION_MAX_COMPLETION_TOKENS = 512
const MAX_TRANSLATION_MAX_COMPLETION_TOKENS = 4_096

class MalformedTranslationJsonError extends Error {
  constructor() {
    super("OpenRouter translation response was malformed JSON")
  }
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}

function clampCompletionTokens(value: number): number {
  return Math.min(MAX_TRANSLATION_MAX_COMPLETION_TOKENS, Math.max(MIN_TRANSLATION_MAX_COMPLETION_TOKENS, value))
}

function estimateTranslationMaxCompletionTokens(sourceText: {
  title?: string | null
  body?: string | null
  caption?: string | null
}): number {
  const sourceLength = [
    sourceText.title,
    sourceText.body,
    sourceText.caption,
  ].reduce((total, value) => total + String(value ?? "").length, 0)
  const estimatedTokens = Math.ceil(sourceLength / 2) + 256
  return clampCompletionTokens(Math.max(DEFAULT_TRANSLATION_MAX_COMPLETION_TOKENS, estimatedTokens))
}

function parseTranslationJson(content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    throw new MalformedTranslationJsonError()
  }
}

function targetLocaleMatchesRequested(parsedTargetLocale: string, requestedTargetLocale: string): boolean {
  const parsed = normalizeContentLocale(parsedTargetLocale)
  const requested = normalizeContentLocale(requestedTargetLocale)
  if (!parsed || !requested) {
    return false
  }
  if (parsed === requested) {
    return true
  }

  const [parsedLanguage] = parsed.split("-")
  const [requestedLanguage] = requested.split("-")
  return Boolean(parsedLanguage && requestedLanguage && parsedLanguage === requestedLanguage && parsed === parsedLanguage)
}

function validateParsedContentTranslation(
  value: unknown,
  requestedTargetLocale: string,
  sourceText: { title?: string | null; body?: string | null; caption?: string | null },
): ParsedContentTranslation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenRouter translation response schema mismatch: expected object")
  }

  const parsed = value as Record<string, unknown>
  if (typeof parsed.source_language !== "string" || !parsed.source_language.trim()) {
    throw new Error("OpenRouter translation response schema mismatch: invalid source_language")
  }
  if (typeof parsed.target_locale !== "string" || !targetLocaleMatchesRequested(parsed.target_locale, requestedTargetLocale)) {
    throw new Error("OpenRouter translation response schema mismatch: target_locale mismatch")
  }
  if (parsed.outcome !== "translated" && parsed.outcome !== "same_language") {
    throw new Error("OpenRouter translation response schema mismatch: invalid outcome")
  }
  if (!isNullableString(parsed.translated_title)) {
    throw new Error("OpenRouter translation response schema mismatch: invalid translated_title")
  }
  if (!isNullableString(parsed.translated_body)) {
    throw new Error("OpenRouter translation response schema mismatch: invalid translated_body")
  }
  if (!isNullableString(parsed.translated_caption)) {
    throw new Error("OpenRouter translation response schema mismatch: invalid translated_caption")
  }

  if (parsed.outcome === "translated") {
    const missingField = missingTranslatedContentField(sourceText, {
      translatedTitle: parsed.translated_title,
      translatedBody: parsed.translated_body,
      translatedCaption: parsed.translated_caption,
    })
    if (missingField) {
      throw new Error(`OpenRouter translation response semantic mismatch: ${missingField} is required for translated outcome`)
    }
  }

  return {
    source_language: parsed.source_language,
    target_locale: parsed.target_locale,
    outcome: parsed.outcome,
    translated_title: parsed.translated_title,
    translated_body: parsed.translated_body,
    translated_caption: parsed.translated_caption,
  }
}

export async function requestContentTranslation(input: {
  env: Env
  sourceText: {
    title?: string | null
    body?: string | null
    caption?: string | null
  }
  sourceLanguage?: string | null
  targetLocale: string
}): Promise<ContentTranslationProviderResult> {
  const apiKey = firstTrimmedEnv(input.env.OPENROUTER_API_KEY)
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured")
  }

  const model = firstTrimmedEnv(input.env.OPENROUTER_TRANSLATION_MODEL)
    || "google/gemini-2.5-flash-lite"
  const timeoutMs = parsePositiveIntegerEnv(input.env.OPENROUTER_TRANSLATION_TIMEOUT_MS)
    ?? parsePositiveIntegerEnv(input.env.OPENROUTER_TIMEOUT_MS)
  const initialMaxCompletionTokens = parsePositiveIntegerEnv(input.env.OPENROUTER_TRANSLATION_MAX_COMPLETION_TOKENS)
    ?? estimateTranslationMaxCompletionTokens(input.sourceText)

  let maxCompletionTokens = clampCompletionTokens(initialMaxCompletionTokens)
  let lastMalformedJsonError: MalformedTranslationJsonError | null = null

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { body, content } = await requestOpenRouterChatCompletion({
      apiKey,
      baseUrl: input.env.OPENROUTER_BASE_URL,
      errorLabel: "translation",
      timeoutMs,
      body: {
        model,
        temperature: 0,
        max_completion_tokens: maxCompletionTokens,
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "content_translation",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              required: [
                "source_language",
                "target_locale",
                "outcome",
                "translated_title",
                "translated_body",
                "translated_caption",
              ],
              properties: {
                source_language: { type: "string" },
                target_locale: { type: "string" },
                outcome: {
                  type: "string",
                  enum: ["translated", "same_language"],
                },
                translated_title: { type: ["string", "null"] },
                translated_body: { type: ["string", "null"] },
                translated_caption: { type: ["string", "null"] },
              },
            },
          },
        },
        messages: [
          {
            role: "system",
            content:
              "Translate the supplied social post text into the requested locale. " +
              "Preserve meaning and tone. Return outcome same_language when translation is unnecessary. " +
              "Do not invent text for null fields.",
          },
          {
            role: "user",
            content: JSON.stringify({
              source_language_hint: input.sourceLanguage ?? null,
              target_locale: input.targetLocale,
              title: input.sourceText.title ?? null,
              body: input.sourceText.body ?? null,
              caption: input.sourceText.caption ?? null,
            }),
          },
        ],
      },
    })

    try {
      const parsed = validateParsedContentTranslation(parseTranslationJson(content), input.targetLocale, input.sourceText)

      return {
        provider: "openrouter",
        model,
        sourceLanguage: parsed.source_language,
        targetLocale: parsed.target_locale,
        outcome: parsed.outcome,
        translatedTitle: parsed.translated_title,
        translatedBody: parsed.translated_body,
        translatedCaption: parsed.translated_caption,
        providerResult: body,
      }
    } catch (error) {
      if (!(error instanceof MalformedTranslationJsonError) || maxCompletionTokens >= MAX_TRANSLATION_MAX_COMPLETION_TOKENS) {
        throw error
      }
      lastMalformedJsonError = error
      maxCompletionTokens = MAX_TRANSLATION_MAX_COMPLETION_TOKENS
    }
  }
  throw lastMalformedJsonError ?? new Error("OpenRouter translation response was malformed JSON")
}
