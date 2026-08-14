import type { Env } from "../../env"
import {
  DEFAULT_OPENROUTER_MODEL,
  firstTrimmedEnv,
  parsePositiveIntegerEnv,
  requestOpenRouterChatCompletion,
} from "../openrouter-client"
import { normalizeContentLocale } from "./content-locale"

export const DEFAULT_LYRICS_LANGUAGE_MIN_CONFIDENCE = 0.75

export function lyricsLanguageConfidenceFloor(env: Pick<Env, "OPENROUTER_LANGUAGE_DETECTION_MIN_CONFIDENCE">): number {
  const value = env.OPENROUTER_LANGUAGE_DETECTION_MIN_CONFIDENCE
  const parsed = Number.parseFloat(firstTrimmedEnv(value))
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1
    ? parsed
    : DEFAULT_LYRICS_LANGUAGE_MIN_CONFIDENCE
}

export type LyricsLanguageDetectionResult = {
  provider: "openrouter"
  model: string
  language: string | null
  confidence: number | null
  reliable: boolean
  providerResult: Record<string, unknown> | null
}

type ParsedLyricsLanguageDetection = {
  lyrics_language: string | null
  lyrics_language_confidence: number | null
  lyrics_language_reliable: boolean
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string"
}

function parseResponse(content: string): ParsedLyricsLanguageDetection {
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    throw new Error("OpenRouter lyrics-language response was malformed JSON")
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenRouter lyrics-language response schema mismatch: expected object")
  }
  const parsed = value as Record<string, unknown>
  if (!nullableString(parsed.lyrics_language)) {
    throw new Error("OpenRouter lyrics-language response schema mismatch: invalid lyrics_language")
  }
  if (parsed.lyrics_language_confidence !== null
    && (typeof parsed.lyrics_language_confidence !== "number"
      || !Number.isFinite(parsed.lyrics_language_confidence)
      || parsed.lyrics_language_confidence < 0
      || parsed.lyrics_language_confidence > 1)) {
    throw new Error("OpenRouter lyrics-language response schema mismatch: invalid confidence")
  }
  if (typeof parsed.lyrics_language_reliable !== "boolean") {
    throw new Error("OpenRouter lyrics-language response schema mismatch: invalid reliability")
  }
  return {
    lyrics_language: parsed.lyrics_language,
    lyrics_language_confidence: parsed.lyrics_language_confidence,
    lyrics_language_reliable: parsed.lyrics_language_reliable,
  }
}

export async function requestLyricsLanguageDetection(input: {
  env: Env
  fetcher?: typeof fetch
  lyrics: string
}): Promise<LyricsLanguageDetectionResult> {
  const apiKey = firstTrimmedEnv(input.env.OPENROUTER_API_KEY)
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not configured")
  const model = firstTrimmedEnv(
    input.env.OPENROUTER_LANGUAGE_DETECTION_MODEL,
    input.env.OPENROUTER_MODEL,
  ) || DEFAULT_OPENROUTER_MODEL
  const timeoutMs = parsePositiveIntegerEnv(firstTrimmedEnv(
    input.env.OPENROUTER_LANGUAGE_DETECTION_TIMEOUT_MS,
    input.env.OPENROUTER_TIMEOUT_MS,
  ))
  const maxCompletionTokens = parsePositiveIntegerEnv(input.env.OPENROUTER_LANGUAGE_DETECTION_MAX_COMPLETION_TOKENS) ?? 256
  const { body, content } = await requestOpenRouterChatCompletion({
    apiKey,
    baseUrl: input.env.OPENROUTER_BASE_URL,
    errorLabel: "lyrics-language detection",
    fetcher: input.fetcher,
    timeoutMs,
    body: {
      model,
      temperature: 0,
      max_completion_tokens: maxCompletionTokens,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "lyrics_language_detection",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["lyrics_language", "lyrics_language_confidence", "lyrics_language_reliable"],
            properties: {
              lyrics_language: { type: ["string", "null"] },
              lyrics_language_confidence: { type: ["number", "null"], minimum: 0, maximum: 1 },
              lyrics_language_reliable: { type: "boolean" },
            },
          },
        },
      },
      messages: [
        {
          role: "system",
          content:
            "Detect the dominant language of the lyrics alone. Ignore titles, captions, "
            + "artist names, and any metadata. Return a BCP-47 language tag when the "
            + "lyrics are sufficiently clear; otherwise return null and reliable false. "
            + "Do not translate or explain.",
        },
        { role: "user", content: input.lyrics },
      ],
    },
  })
  const parsed = parseResponse(content)
  const language = normalizeContentLocale(parsed.lyrics_language)
  const minConfidence = lyricsLanguageConfidenceFloor(input.env)
  const reliable = parsed.lyrics_language_reliable
    && Boolean(language)
    && parsed.lyrics_language_confidence !== null
    && parsed.lyrics_language_confidence >= minConfidence
  return {
    provider: "openrouter",
    model,
    language,
    confidence: parsed.lyrics_language_confidence,
    reliable,
    providerResult: body,
  }
}
