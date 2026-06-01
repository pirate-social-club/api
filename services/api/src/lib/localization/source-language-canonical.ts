import type { DbExecutor } from "../db-helpers"
import { normalizeDetectedSourceLanguage } from "./content-locale"

export type ProviderSourceLanguageDetection = {
  sourceLanguage: string | null
  sourceLanguageConfidence: number | null
  sourceLanguageReliable: boolean
  detector: string
  sourceHash: string
  detectedAt: string
}

export async function tableHasLanguageDetectionColumns(executor: DbExecutor, tableName: "posts" | "comments"): Promise<boolean> {
  const result = await executor.execute(`PRAGMA table_info(${tableName})`)
  const columnNames = new Set(result.rows.map((row) => String(row.name ?? "")))
  return columnNames.has("source_language_confidence")
    && columnNames.has("source_language_reliable")
    && columnNames.has("source_language_detector")
    && columnNames.has("source_language_detected_at")
    && columnNames.has("source_language_source_hash")
}

async function updateCanonicalSourceLanguage(input: {
  executor: DbExecutor
  tableName: "posts" | "comments"
  idColumn: "post_id" | "comment_id"
  id: string
  detection: ProviderSourceLanguageDetection
}): Promise<void> {
  const sourceLanguage = normalizeDetectedSourceLanguage(input.detection.sourceLanguage)
  const sourceLanguageReliable = input.detection.sourceLanguageReliable && Boolean(sourceLanguage)

  if (await tableHasLanguageDetectionColumns(input.executor, input.tableName)) {
    await input.executor.execute({
      sql: `
        UPDATE ${input.tableName}
        SET source_language = ?1,
            source_language_confidence = ?2,
            source_language_reliable = ?3,
            source_language_detector = ?4,
            source_language_detected_at = ?5,
            source_language_source_hash = ?6
        WHERE ${input.idColumn} = ?7
          AND (
            source_language_source_hash IS NULL
            OR source_language_source_hash != ?6
            OR source_language_reliable = 0
            OR ?3 = 1
          )
      `,
      args: [
        sourceLanguage,
        input.detection.sourceLanguageConfidence,
        sourceLanguageReliable ? 1 : 0,
        input.detection.detector,
        input.detection.detectedAt,
        input.detection.sourceHash,
        input.id,
      ],
    })
    return
  }

  await input.executor.execute({
    sql: `
      UPDATE ${input.tableName}
      SET source_language = ?1
      WHERE ${input.idColumn} = ?2
    `,
    args: [sourceLanguage, input.id],
  })
}

export async function updatePostSourceLanguageFromProvider(input: {
  executor: DbExecutor
  postId: string
  detection: ProviderSourceLanguageDetection
}): Promise<void> {
  await updateCanonicalSourceLanguage({
    executor: input.executor,
    tableName: "posts",
    idColumn: "post_id",
    id: input.postId,
    detection: input.detection,
  })
}

export async function updateCommentSourceLanguageFromProvider(input: {
  executor: DbExecutor
  commentId: string
  detection: ProviderSourceLanguageDetection
}): Promise<void> {
  await updateCanonicalSourceLanguage({
    executor: input.executor,
    tableName: "comments",
    idColumn: "comment_id",
    id: input.commentId,
    detection: input.detection,
  })
}
