import type { Env } from "../../env"
import type { StudyGeneratedLine } from "./post-study-generation-provider"

const DEFAULT_STUDY_GENERATION_CHUNK_SIZE = 10

export function classifyStudyGenerationError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/malformed JSON/iu.test(message)) return "malformed_json"
  if (/unexpected line_id|schema_line_id/iu.test(message)) return "schema_line_id"
  if (/missing translation distractors|schema_missing_distractors/iu.test(message)) return "schema_missing_distractors"
  if (/invalid translation distractors|schema_invalid_distractors/iu.test(message)) return "schema_invalid_distractors"
  if (/schema_source_mismatch|source_text/iu.test(message)) return "schema_source_mismatch"
  if (/expected object|lines must be an array|invalid line|no valid generated lines|no generated lines|schema_shape/iu.test(message)) return "schema_shape"
  if (/schema mismatch/iu.test(message)) return "schema_mismatch"
  if (/timed out|timeout|abort/iu.test(message)) return "timeout"
  if (/OpenRouter|HTTP|status|fetch|network/iu.test(message)) return "provider_error"
  return "unknown"
}

export function compactGenerationResultRef(input: {
  failedChunks: number
  failureCodes: string[]
  generatedLineCount: number
  skippedLineCount: number
  skippedReasonCodes: string[]
  targetLanguage: string
  totalChunks: number
  unavailableLineCount: number
}): string {
  const failureCodes = [...new Set(input.failureCodes)].slice(0, 3)
  const skippedReasonCodes = [...new Set(input.skippedReasonCodes)].slice(0, 3)
  const diagnosticParts = [
    failureCodes.length ? `errors=${failureCodes.join("+")}` : null,
    input.skippedLineCount > 0 ? `skipped=${input.skippedLineCount}` : null,
    skippedReasonCodes.length ? `skip_errors=${skippedReasonCodes.join("+")}` : null,
  ]
  if (input.failedChunks === 0 && input.unavailableLineCount === 0) {
    return ["ready", input.targetLanguage, ...diagnosticParts].filter(Boolean).join(":")
  }
  if (input.generatedLineCount > 0) {
    return [
      "ready_partial",
      input.targetLanguage,
      `generated=${input.generatedLineCount}`,
      `unavailable=${input.unavailableLineCount}`,
      `failed_chunks=${input.failedChunks}/${input.totalChunks}`,
      ...diagnosticParts,
    ].filter(Boolean).join(":")
  }
  return [
    "fallback",
    input.targetLanguage,
    `unavailable=${input.unavailableLineCount}`,
    `failed_chunks=${input.failedChunks}/${input.totalChunks}`,
    ...diagnosticParts,
  ].filter(Boolean).join(":")
}

export function chunkStudyGenerationLines<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize))
  }
  return chunks
}

export function studyGenerationChunkSize(env: Env): number {
  const configured = Number(env.OPENROUTER_STUDY_GENERATION_CHUNK_SIZE ?? "")
  if (Number.isInteger(configured) && configured > 0) {
    return Math.min(configured, 25)
  }
  return DEFAULT_STUDY_GENERATION_CHUNK_SIZE
}

function optionId(lineIndex: number, optionIndex: number): string {
  return `line_${String(lineIndex + 1).padStart(3, "0")}_opt_${optionIndex + 1}`
}

export function orderedTranslationOptions(input: {
  generated: StudyGeneratedLine
  lineIndex: number
}): { correctOptionId: string; options: Array<{ id: string; text: string }> } {
  const values = [
    input.generated.translation,
    ...input.generated.distractors.filter((distractor) => distractor !== input.generated.translation),
  ].slice(0, 4)
  const rotation = input.lineIndex % values.length
  const rotated = [...values.slice(rotation), ...values.slice(0, rotation)]
  const options = rotated.map((text, index) => ({
    id: optionId(input.lineIndex, index),
    text,
  }))
  const correctOptionId = options.find((option) => option.text === input.generated.translation)?.id
    ?? options[0]?.id
    ?? optionId(input.lineIndex, 0)
  return { correctOptionId, options }
}
