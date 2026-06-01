import type { Env } from "../../env"
import {
  firstTrimmedEnv,
  parsePositiveIntegerEnv,
  requestOpenRouterChatCompletion,
} from "../openrouter-client"
import { normalizeContentLocale, normalizeDetectedSourceLanguage } from "./content-locale"

export type ContentTranslationProviderResult = {
  provider: "openrouter"
  model: string
  sourceLanguage: string | null
  sourceLanguageConfidence: number | null
  sourceLanguageReliable: boolean
  detectedLanguages: Array<{
    language: string
    confidence: number | null
    textCoverage: number | null
  }>
  targetLocale: string
  outcome: "translated" | "same_language"
  translatedTitle: string | null
  translatedBody: string | null
  translatedCaption: string | null
  providerResult: Record<string, unknown> | null
}

export type ContentSourceLanguageDetectionProviderResult = {
  provider: "openrouter"
  model: string
  sourceLanguage: string | null
  sourceLanguageConfidence: number | null
  sourceLanguageReliable: boolean
  detectedLanguages: Array<{
    language: string
    confidence: number | null
    textCoverage: number | null
  }>
  providerResult: Record<string, unknown> | null
}

type ParsedContentTranslation = {
  source_language: string | null
  source_language_confidence: number | null
  source_language_reliable: boolean
  detected_languages: Array<{
    language: string
    confidence: number | null
    text_coverage: number | null
  }>
  target_locale: string
  outcome: "translated" | "same_language"
  translated_title: string | null
  translated_body: string | null
  translated_caption: string | null
}

type ParsedSourceLanguageDetection = Pick<
  ParsedContentTranslation,
  "source_language" | "source_language_confidence" | "source_language_reliable" | "detected_languages"
>

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

function isNullableNumber(value: unknown): value is number | null {
  return value === null || typeof value === "number" && Number.isFinite(value)
}

function parseDetectedLanguages(value: unknown): ParsedContentTranslation["detected_languages"] {
  if (value == null) {
    return []
  }
  if (!Array.isArray(value)) {
    throw new Error("OpenRouter translation response schema mismatch: invalid detected_languages")
  }

  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("OpenRouter translation response schema mismatch: invalid detected_languages item")
    }
    const record = item as Record<string, unknown>
    if (!isNullableString(record.language)) {
      throw new Error("OpenRouter translation response schema mismatch: invalid detected language")
    }
    if (!isNullableNumber(record.confidence)) {
      throw new Error("OpenRouter translation response schema mismatch: invalid detected language confidence")
    }
    if (!isNullableNumber(record.text_coverage)) {
      throw new Error("OpenRouter translation response schema mismatch: invalid detected language text_coverage")
    }
    return {
      language: normalizeDetectedSourceLanguage(record.language) ?? String(record.language ?? "").trim(),
      confidence: record.confidence,
      text_coverage: record.text_coverage,
    }
  })
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

function validateParsedContentTranslation(value: unknown, requestedTargetLocale: string): ParsedContentTranslation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenRouter translation response schema mismatch: expected object")
  }

  const parsed = value as Record<string, unknown>
  if (!isNullableString(parsed.source_language) || typeof parsed.source_language === "string" && !parsed.source_language.trim()) {
    throw new Error("OpenRouter translation response schema mismatch: invalid source_language")
  }
  const sourceLanguage = normalizeDetectedSourceLanguage(parsed.source_language)
  const sourceLanguageConfidence = isNullableNumber(parsed.source_language_confidence)
    ? parsed.source_language_confidence
    : null
  const sourceLanguageReliable = parsed.source_language_reliable === true
    && Boolean(sourceLanguage)
    && sourceLanguageConfidence != null
    && sourceLanguageConfidence >= 0
    && sourceLanguageConfidence <= 1
  if (
    parsed.source_language_confidence !== undefined
    && !isNullableNumber(parsed.source_language_confidence)
  ) {
    throw new Error("OpenRouter translation response schema mismatch: invalid source_language_confidence")
  }
  if (
    parsed.source_language_reliable !== undefined
    && typeof parsed.source_language_reliable !== "boolean"
  ) {
    throw new Error("OpenRouter translation response schema mismatch: invalid source_language_reliable")
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

  return {
    source_language: sourceLanguage,
    source_language_confidence: sourceLanguageConfidence,
    source_language_reliable: sourceLanguageReliable,
    detected_languages: parseDetectedLanguages(parsed.detected_languages),
    target_locale: parsed.target_locale,
    outcome: parsed.outcome,
    translated_title: parsed.translated_title,
    translated_body: parsed.translated_body,
    translated_caption: parsed.translated_caption,
  }
}

function validateParsedSourceLanguageDetection(value: unknown): ParsedSourceLanguageDetection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenRouter language detection response schema mismatch: expected object")
  }

  const parsed = value as Record<string, unknown>
  if (!isNullableString(parsed.source_language) || typeof parsed.source_language === "string" && !parsed.source_language.trim()) {
    throw new Error("OpenRouter language detection response schema mismatch: invalid source_language")
  }
  if (!isNullableNumber(parsed.source_language_confidence)) {
    throw new Error("OpenRouter language detection response schema mismatch: invalid source_language_confidence")
  }
  if (typeof parsed.source_language_reliable !== "boolean") {
    throw new Error("OpenRouter language detection response schema mismatch: invalid source_language_reliable")
  }

  const sourceLanguage = normalizeDetectedSourceLanguage(parsed.source_language)
  const sourceLanguageReliable = parsed.source_language_reliable === true
    && Boolean(sourceLanguage)
    && parsed.source_language_confidence != null
    && parsed.source_language_confidence >= 0
    && parsed.source_language_confidence <= 1

  return {
    source_language: sourceLanguage,
    source_language_confidence: parsed.source_language_confidence,
    source_language_reliable: sourceLanguageReliable,
    detected_languages: parseDetectedLanguages(parsed.detected_languages),
  }
}

function sourceLanguageDetectionResponseSchema(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "source_language",
      "source_language_confidence",
      "source_language_reliable",
      "detected_languages",
    ],
    properties: {
      source_language: { type: ["string", "null"] },
      source_language_confidence: { type: ["number", "null"] },
      source_language_reliable: { type: "boolean" },
      detected_languages: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["language", "confidence", "text_coverage"],
          properties: {
            language: { type: ["string", "null"] },
            confidence: { type: ["number", "null"] },
            text_coverage: { type: ["number", "null"] },
          },
        },
      },
    },
  }
}

function sourceLanguageDetectionResponseProperties(): Record<string, unknown> {
  return (sourceLanguageDetectionResponseSchema() as { properties: Record<string, unknown> }).properties
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
    || "google/gemini-2.5-flash-lite-preview-09-2025"
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
                "source_language_confidence",
                "source_language_reliable",
                "detected_languages",
                "target_locale",
                "outcome",
                "translated_title",
                "translated_body",
                "translated_caption",
              ],
              properties: {
                ...sourceLanguageDetectionResponseProperties(),
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
              "Identify the primary language of the user-visible text. Ignore URLs, domains, handles, hashtags, code, markup, and proper names when deciding source language. " +
              "If the text is mostly one language with brief words or names from another language, return the dominant language. If no primary language is reliable, return source_language null and source_language_reliable false. " +
              "Use BCP-47 language tags where possible and set source_language_confidence from 0 to 1. " +
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
      const parsed = validateParsedContentTranslation(parseTranslationJson(content), input.targetLocale)

      return {
        provider: "openrouter",
        model,
        sourceLanguage: parsed.source_language,
        sourceLanguageConfidence: parsed.source_language_confidence,
        sourceLanguageReliable: parsed.source_language_reliable,
        detectedLanguages: parsed.detected_languages.map((language) => ({
          language: language.language,
          confidence: language.confidence,
          textCoverage: language.text_coverage,
        })),
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

export async function requestSourceLanguageDetection(input: {
  env: Env
  sourceText: {
    title?: string | null
    body?: string | null
    caption?: string | null
  }
}): Promise<ContentSourceLanguageDetectionProviderResult> {
  const apiKey = firstTrimmedEnv(input.env.OPENROUTER_API_KEY)
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured")
  }

  const model = firstTrimmedEnv(input.env.OPENROUTER_TRANSLATION_MODEL)
    || "google/gemini-2.5-flash-lite-preview-09-2025"
  const timeoutMs = parsePositiveIntegerEnv(input.env.OPENROUTER_TRANSLATION_TIMEOUT_MS)
    ?? parsePositiveIntegerEnv(input.env.OPENROUTER_TIMEOUT_MS)
  const maxCompletionTokens = parsePositiveIntegerEnv(input.env.OPENROUTER_LANGUAGE_DETECTION_MAX_COMPLETION_TOKENS)
    ?? 256

  const { body, content } = await requestOpenRouterChatCompletion({
    apiKey,
    baseUrl: input.env.OPENROUTER_BASE_URL,
    errorLabel: "language detection",
    timeoutMs,
    body: {
      model,
      temperature: 0,
      max_completion_tokens: Math.max(64, Math.min(512, maxCompletionTokens)),
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "source_language_detection",
          strict: true,
          schema: sourceLanguageDetectionResponseSchema(),
        },
      },
      messages: [
        {
          role: "system",
          content:
            "Identify the primary language of the supplied user-visible social text. " +
            "Ignore URLs, domains, handles, hashtags, code, markup, and proper names when deciding source language. " +
            "If the text is mostly one language with brief words or names from another language, return the dominant language. " +
            "If no primary language is reliable, return source_language null and source_language_reliable false. " +
            "Use BCP-47 language tags where possible and set source_language_confidence from 0 to 1.",
        },
        {
          role: "user",
          content: JSON.stringify({
            title: input.sourceText.title ?? null,
            body: input.sourceText.body ?? null,
            caption: input.sourceText.caption ?? null,
          }),
        },
      ],
    },
  })

  const parsed = validateParsedSourceLanguageDetection(parseTranslationJson(content))
  return {
    provider: "openrouter",
    model,
    sourceLanguage: parsed.source_language,
    sourceLanguageConfidence: parsed.source_language_confidence,
    sourceLanguageReliable: parsed.source_language_reliable,
    detectedLanguages: parsed.detected_languages.map((language) => ({
      language: language.language,
      confidence: language.confidence,
      textCoverage: language.text_coverage,
    })),
    providerResult: body,
  }
}
