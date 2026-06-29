import type { Env } from "../../env"
import {
  firstTrimmedEnv,
  parsePositiveIntegerEnv,
  requestOpenRouterChatCompletion,
} from "../openrouter-client"

export type StudyGeneratedLine = {
  explanation?: string | null
  lineId: string
  translation: string
  distractors: string[]
}

export type StudyPackGenerationResult = {
  model: string
  provider: "openrouter"
  lines: StudyGeneratedLine[]
}

type ParsedGeneratedLine = {
  explanation: string | null
  line_id: string
  translation: string
  distractors: string[]
}

const DEFAULT_STUDY_GENERATION_MODEL = "google/gemini-2.5-flash-lite-preview-09-2025"
const DEFAULT_STUDY_GENERATION_MAX_COMPLETION_TOKENS = 4_096

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function parseStudyGenerationJson(content: string): unknown {
  try {
    return JSON.parse(content) as unknown
  } catch {
    throw new Error("OpenRouter study generation response was malformed JSON")
  }
}

function validateStudyGeneration(value: unknown, requestedLineIds: Set<string>): ParsedGeneratedLine[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenRouter study generation response schema mismatch: expected object")
  }
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.lines)) {
    throw new Error("OpenRouter study generation response schema mismatch: lines must be an array")
  }

  const seen = new Set<string>()
  const lines: ParsedGeneratedLine[] = []
  for (const item of record.lines) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("OpenRouter study generation response schema mismatch: invalid line")
    }
    const line = item as Record<string, unknown>
    const lineId = typeof line.line_id === "string" ? line.line_id.trim() : ""
    const translation = typeof line.translation === "string" ? line.translation.trim() : ""
    const explanation = typeof line.explanation === "string" ? line.explanation.trim() : null
    const distractors = isStringArray(line.distractors)
      ? line.distractors.map((distractor) => distractor.trim()).filter(Boolean)
      : []
    if (!lineId || !requestedLineIds.has(lineId) || seen.has(lineId)) {
      throw new Error("OpenRouter study generation response schema mismatch: unexpected line_id")
    }
    if (!translation || distractors.length < 3) {
      throw new Error("OpenRouter study generation response schema mismatch: missing translation distractors")
    }
    seen.add(lineId)
    lines.push({
      line_id: lineId,
      explanation,
      translation,
      distractors: distractors.filter((distractor) => distractor !== translation).slice(0, 3),
    })
  }

  if (lines.length === 0) {
    throw new Error("OpenRouter study generation response schema mismatch: no generated lines")
  }
  return lines
}

export function canGenerateStudyTranslations(env: Env): boolean {
  return Boolean(firstTrimmedEnv(env.OPENROUTER_API_KEY))
}

export async function requestStudyPackGeneration(input: {
  env: Env
  lines: Array<{ lineId: string; next?: string | null; previous?: string | null; text: string }>
  sourceLanguage?: string | null
  targetLanguage: string
}): Promise<StudyPackGenerationResult> {
  const apiKey = firstTrimmedEnv(input.env.OPENROUTER_API_KEY)
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not configured")
  }
  const model = firstTrimmedEnv(
    input.env.OPENROUTER_TRANSLATION_MODEL,
    input.env.OPENROUTER_MODEL,
  ) || DEFAULT_STUDY_GENERATION_MODEL
  const timeoutMs = parsePositiveIntegerEnv(input.env.OPENROUTER_TRANSLATION_TIMEOUT_MS)
    ?? parsePositiveIntegerEnv(input.env.OPENROUTER_TIMEOUT_MS)
  const requestedLineIds = new Set(input.lines.map((line) => line.lineId))

  const { content } = await requestOpenRouterChatCompletion({
    apiKey,
    baseUrl: input.env.OPENROUTER_BASE_URL,
    errorLabel: "study generation",
    timeoutMs,
    body: {
      model,
      temperature: 0.2,
      max_completion_tokens: DEFAULT_STUDY_GENERATION_MAX_COMPLETION_TOKENS,
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "song_study_pack_generation",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["lines"],
            properties: {
              lines: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["line_id", "translation", "distractors", "explanation"],
                  properties: {
                    line_id: { type: "string" },
                    translation: { type: "string" },
                    explanation: { type: "string" },
                    distractors: {
                      type: "array",
                      minItems: 3,
                      maxItems: 3,
                      items: { type: "string" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      messages: [
        {
          role: "system",
          content:
            "Generate language-learning exercises from lyric lines. " +
            "For each supplied source line, produce a natural meaning-based answer in the requested target language, exactly three plausible but incorrect target-language distractors, and a brief explanation in the target language. " +
            "Answers and distractors must be written entirely in the target language, not transliteration or mixed lyric style. " +
            "Use previous/next source lines only as context. Keep translations concise and appropriate for music lyrics. Do not add lines or change line_id values.",
        },
        {
          role: "user",
          content: JSON.stringify({
            source_language_hint: input.sourceLanguage ?? null,
            target_language: input.targetLanguage,
            lines: input.lines.map((line) => ({
              line_id: line.lineId,
              next_line: line.next ?? null,
              previous_line: line.previous ?? null,
              text: line.text,
            })),
          }),
        },
      ],
    },
  })

  return {
    provider: "openrouter",
    model,
    lines: validateStudyGeneration(parseStudyGenerationJson(content), requestedLineIds).map((line) => ({
      lineId: line.line_id,
      explanation: line.explanation,
      translation: line.translation,
      distractors: line.distractors,
    })),
  }
}
