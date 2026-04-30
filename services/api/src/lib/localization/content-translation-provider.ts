import type { Env } from "../../env"
import { normalizeContentLocale } from "./content-locale"

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

type ParsedContentTranslation = {
  source_language: string
  target_locale: string
  outcome: "translated" | "same_language"
  translated_title: string | null
  translated_body: string | null
  translated_caption: string | null
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string"
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
  const apiKey = trimEnv(input.env.OPENROUTER_API_KEY)
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured")
  }

  const baseUrl = trimEnv(input.env.OPENROUTER_BASE_URL) || "https://openrouter.ai/api/v1"
  const model = trimEnv(input.env.OPENROUTER_TRANSLATION_MODEL) || "google/gemini-2.5-flash-lite-preview-09-2025"
  const timeoutMs = Number.parseInt(trimEnv(input.env.OPENROUTER_TRANSLATION_TIMEOUT_MS) || trimEnv(input.env.OPENROUTER_TIMEOUT_MS), 10)
  const controller = new AbortController()
  const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? setTimeout(() => controller.abort(), timeoutMs)
    : null

  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_completion_tokens: 240,
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
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`OpenRouter translation request failed with http_${response.status}`)
    }

    const body = await response.json().catch(() => null) as
      | {
          choices?: Array<{ message?: { content?: unknown } }>
        }
      | null
    if (!body) {
      throw new Error("OpenRouter translation response was not valid JSON")
    }

    const normalizedContent = normalizeMessageContent(body.choices?.[0]?.message?.content)
    if (!normalizedContent.trim()) {
      throw new Error("OpenRouter translation response was empty")
    }

    const parsed = validateParsedContentTranslation(JSON.parse(normalizedContent), input.targetLocale)

    return {
      provider: "openrouter",
      model,
      sourceLanguage: parsed.source_language,
      targetLocale: parsed.target_locale,
      outcome: parsed.outcome,
      translatedTitle: parsed.translated_title,
      translatedBody: parsed.translated_body,
      translatedCaption: parsed.translated_caption,
      providerResult: body as Record<string, unknown>,
    }
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
