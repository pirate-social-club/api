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

export type StudyGenerationSkippedLine = {
  lineId: string | null
  reason: "schema_shape" | "schema_line_id" | "schema_missing_distractors" | "schema_invalid_distractors" | "schema_source_mismatch"
}

export type StudyPackGenerationResult = {
  model: string
  provider: "openrouter"
  lines: StudyGeneratedLine[]
  skipped: StudyGenerationSkippedLine[]
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

function normalizeGeneratedChoice(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase()
}

// Tolerant comparison for the echoed source line: ignore case, punctuation, and
// whitespace differences, but still detect when the model translated a *different*
// line than the one a given line_id requested (the chunk-drift / off-by-one failure).
function normalizeSourceForEcho(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
}

function validateStudyGeneration(value: unknown, requestedLines: Map<string, string>): {
  lines: ParsedGeneratedLine[]
  skipped: StudyGenerationSkippedLine[]
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("OpenRouter study generation response schema mismatch: expected object")
  }
  const record = value as Record<string, unknown>
  if (!Array.isArray(record.lines)) {
    throw new Error("OpenRouter study generation response schema mismatch: lines must be an array")
  }

  const seen = new Set<string>()
  const lines: ParsedGeneratedLine[] = []
  const skipped: StudyGenerationSkippedLine[] = []
  for (const item of record.lines) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      skipped.push({ lineId: null, reason: "schema_shape" })
      continue
    }
    const line = item as Record<string, unknown>
    const lineId = typeof line.line_id === "string" ? line.line_id.trim() : ""
    const sourceText = typeof line.source_text === "string" ? line.source_text.trim() : ""
    const translation = typeof line.translation === "string" ? line.translation.trim() : ""
    const explanation = typeof line.explanation === "string" ? line.explanation.trim() : null
    const distractors = isStringArray(line.distractors)
      ? line.distractors.map((distractor) => distractor.trim()).filter(Boolean)
      : []
    if (!lineId || !requestedLines.has(lineId) || seen.has(lineId)) {
      skipped.push({ lineId: lineId || null, reason: "schema_line_id" })
      continue
    }
    // Guard against chunk-drift: the model must echo the exact source line it
    // translated for this line_id. A mismatch means it translated a neighbouring
    // line (the off-by-one shift) — reject rather than serve a wrong answer key.
    const expectedSource = requestedLines.get(lineId) ?? ""
    if (!sourceText || normalizeSourceForEcho(sourceText) !== normalizeSourceForEcho(expectedSource)) {
      skipped.push({ lineId, reason: "schema_source_mismatch" })
      seen.add(lineId)
      continue
    }
    if (!translation || distractors.length < 3) {
      skipped.push({ lineId, reason: "schema_missing_distractors" })
      seen.add(lineId)
      continue
    }
    const normalizedTranslation = normalizeGeneratedChoice(translation)
    const seenDistractors = new Set<string>()
    const validDistractors = distractors.filter((distractor) => {
      const normalized = normalizeGeneratedChoice(distractor)
      if (!normalized || normalized === normalizedTranslation || seenDistractors.has(normalized)) {
        return false
      }
      seenDistractors.add(normalized)
      return true
    })
    if (validDistractors.length < 3) {
      skipped.push({ lineId, reason: "schema_invalid_distractors" })
      seen.add(lineId)
      continue
    }
    seen.add(lineId)
    lines.push({
      line_id: lineId,
      explanation,
      translation,
      distractors: validDistractors.slice(0, 3),
    })
  }

  if (lines.length === 0) {
    const reasons = [...new Set(skipped.map((line) => line.reason))]
    throw new Error(`OpenRouter study generation response schema mismatch: no valid generated lines${reasons.length ? ` (${reasons.join("+")})` : ""}`)
  }
  return { lines, skipped }
}

export function canGenerateStudyTranslations(env: Env): boolean {
  return Boolean(firstTrimmedEnv(env.OPENROUTER_API_KEY))
}

export async function requestStudyPackGeneration(input: {
  env: Env
  lines: Array<{ lineId: string; previous?: string | null; text: string }>
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
  const maxCompletionTokens = parsePositiveIntegerEnv(input.env.OPENROUTER_TRANSLATION_MAX_COMPLETION_TOKENS)
    ?? DEFAULT_STUDY_GENERATION_MAX_COMPLETION_TOKENS
  const requestedLines = new Map(input.lines.map((line) => [line.lineId, line.text]))

  const { content } = await requestOpenRouterChatCompletion({
    apiKey,
    baseUrl: input.env.OPENROUTER_BASE_URL,
    errorLabel: "study generation",
    timeoutMs,
    body: {
      model,
      temperature: 0.2,
      max_completion_tokens: maxCompletionTokens,
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
                  required: ["line_id", "source_text", "translation", "distractors", "explanation"],
                  properties: {
                    line_id: { type: "string" },
                    source_text: { type: "string" },
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
            "Translate ONLY the `text` value of each supplied line. " +
            "`context_previous_line` is provided solely for disambiguation — never translate it. " +
            "For each line, return its `line_id`, a `source_text` field that copies the `text` value you translated EXACTLY (verbatim, unchanged), a natural meaning-based `translation` in the requested target language, exactly three plausible but incorrect target-language distractors, and a brief explanation in the target language. " +
            "Answers and distractors must be written entirely in the target language, not transliteration or mixed lyric style. " +
            "Keep translations concise and appropriate for music lyrics. Do not add lines, drop lines, reorder lines, or change line_id values.",
        },
        {
          role: "user",
          content: JSON.stringify({
            source_language_hint: input.sourceLanguage ?? null,
            target_language: input.targetLanguage,
            lines: input.lines.map((line) => ({
              line_id: line.lineId,
              context_previous_line: line.previous ?? null,
              text: line.text,
            })),
          }),
        },
      ],
    },
  })

  const validated = validateStudyGeneration(parseStudyGenerationJson(content), requestedLines)
  return {
    provider: "openrouter",
    model,
    skipped: validated.skipped,
    lines: validated.lines.map((line) => ({
      lineId: line.line_id,
      explanation: line.explanation,
      translation: line.translation,
      distractors: line.distractors,
    })),
  }
}
