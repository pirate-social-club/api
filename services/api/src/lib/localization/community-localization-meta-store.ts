import type { DbExecutor } from "../db-helpers"
import { makeId } from "../helpers"
import { executeFirst } from "../db-helpers"
import { boolOrNull, numberOrNull, requiredString, rowValue, stringOrNull } from "../sql-row"
import { normalizeDetectedSourceLanguage } from "./content-locale"

export type CommunityLocalizationTranslationPolicy = "none" | "machine_allowed" | "human_only" | "hybrid"

export type CommunityLocalizationMetaRecord = {
  community_localization_meta_id: string
  community_id: string
  field_key: string
  source_hash: string
  source_language: string | null
  source_language_confidence: number | null
  source_language_reliable: boolean
  source_language_detector: string | null
  source_language_detected_at: string | null
  translation_policy: CommunityLocalizationTranslationPolicy
  created_at: string
  updated_at: string
}

type CommunityLocalizationMetaSchema = {
  hasLanguageDetectionColumns: boolean
}

async function resolveCommunityLocalizationMetaSchema(executor: DbExecutor): Promise<CommunityLocalizationMetaSchema> {
  const result = await executor.execute("PRAGMA table_info(community_localization_meta)")
  const columnNames = new Set(result.rows.map((row) => String(row.name ?? "")))
  return {
    hasLanguageDetectionColumns: columnNames.has("source_language_confidence")
      && columnNames.has("source_language_reliable")
      && columnNames.has("source_language_detector")
      && columnNames.has("source_language_detected_at"),
  }
}

function languageDetectionSelectColumnsForSchema(schema: CommunityLocalizationMetaSchema): string {
  return schema.hasLanguageDetectionColumns
    ? "source_language_confidence, source_language_reliable, source_language_detector, source_language_detected_at"
    : "NULL AS source_language_confidence, 0 AS source_language_reliable, NULL AS source_language_detector, NULL AS source_language_detected_at"
}

function toCommunityLocalizationMetaRecord(row: unknown): CommunityLocalizationMetaRecord {
  return {
    community_localization_meta_id: requiredString(row, "community_localization_meta_id"),
    community_id: requiredString(row, "community_id"),
    field_key: requiredString(row, "field_key"),
    source_hash: requiredString(row, "source_hash"),
    source_language: stringOrNull(rowValue(row, "source_language")),
    source_language_confidence: numberOrNull(rowValue(row, "source_language_confidence")),
    source_language_reliable: boolOrNull(rowValue(row, "source_language_reliable")) ?? false,
    source_language_detector: stringOrNull(rowValue(row, "source_language_detector")),
    source_language_detected_at: stringOrNull(rowValue(row, "source_language_detected_at")),
    translation_policy: requiredString(row, "translation_policy") as CommunityLocalizationTranslationPolicy,
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export async function listCommunityLocalizationMeta(input: {
  executor: DbExecutor
  communityId: string
}): Promise<Map<string, CommunityLocalizationMetaRecord>> {
  const schema = await resolveCommunityLocalizationMetaSchema(input.executor)
  const result = await input.executor.execute({
    sql: `
      SELECT community_localization_meta_id, community_id, field_key, source_hash,
             source_language, ${languageDetectionSelectColumnsForSchema(schema)}, translation_policy, created_at, updated_at
      FROM community_localization_meta
      WHERE community_id = ?1
    `,
    args: [input.communityId],
  })

  return new Map(result.rows.map((row) => {
    const record = toCommunityLocalizationMetaRecord(row)
    return [record.field_key, record] as const
  }))
}

export async function getCommunityLocalizationMeta(input: {
  executor: DbExecutor
  communityId: string
  fieldKey: string
}): Promise<CommunityLocalizationMetaRecord | null> {
  const schema = await resolveCommunityLocalizationMetaSchema(input.executor)
  const row = await executeFirst(input.executor, {
    sql: `
      SELECT community_localization_meta_id, community_id, field_key, source_hash,
             source_language, ${languageDetectionSelectColumnsForSchema(schema)}, translation_policy, created_at, updated_at
      FROM community_localization_meta
      WHERE community_id = ?1
        AND field_key = ?2
      LIMIT 1
    `,
    args: [input.communityId, input.fieldKey],
  })

  return row ? toCommunityLocalizationMetaRecord(row) : null
}

export async function upsertCommunityLocalizationMeta(input: {
  executor: DbExecutor
  communityId: string
  fieldKey: string
  sourceHash: string
  sourceLanguage?: string | null
  sourceLanguageConfidence?: number | null
  sourceLanguageReliable?: boolean
  sourceLanguageDetector?: string | null
  sourceLanguageDetectedAt?: string | null
  translationPolicy: CommunityLocalizationTranslationPolicy
  now: string
}): Promise<void> {
  const schema = await resolveCommunityLocalizationMetaSchema(input.executor)
  const sourceLanguage = normalizeDetectedSourceLanguage(input.sourceLanguage)
  const sourceLanguageReliable = input.sourceLanguageReliable === true && Boolean(sourceLanguage)
  if (schema.hasLanguageDetectionColumns) {
    await input.executor.execute({
      sql: `
        INSERT INTO community_localization_meta (
          community_localization_meta_id, community_id, field_key, source_hash,
          source_language, source_language_confidence, source_language_reliable,
          source_language_detector, source_language_detected_at,
          translation_policy, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4,
          ?5, ?6, ?7,
          ?8, ?9,
          ?10, ?11, ?11
        )
        ON CONFLICT(community_id, field_key) DO UPDATE SET
          source_hash = excluded.source_hash,
          source_language = excluded.source_language,
          source_language_confidence = excluded.source_language_confidence,
          source_language_reliable = excluded.source_language_reliable,
          source_language_detector = excluded.source_language_detector,
          source_language_detected_at = excluded.source_language_detected_at,
          translation_policy = excluded.translation_policy,
          updated_at = excluded.updated_at
      `,
      args: [
        makeId("clm"),
        input.communityId,
        input.fieldKey,
        input.sourceHash,
        sourceLanguage,
        input.sourceLanguageConfidence ?? null,
        sourceLanguageReliable ? 1 : 0,
        input.sourceLanguageDetector ?? null,
        input.sourceLanguageDetectedAt ?? null,
        input.translationPolicy,
        input.now,
      ],
    })
    return
  }

  await input.executor.execute({
    sql: `
      INSERT INTO community_localization_meta (
        community_localization_meta_id, community_id, field_key, source_hash,
        source_language, translation_policy, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4,
        ?5, ?6, ?7, ?7
      )
      ON CONFLICT(community_id, field_key) DO UPDATE SET
        source_hash = excluded.source_hash,
        source_language = excluded.source_language,
        translation_policy = excluded.translation_policy,
        updated_at = excluded.updated_at
    `,
    args: [
      makeId("clm"),
      input.communityId,
      input.fieldKey,
      input.sourceHash,
      sourceLanguage,
      input.translationPolicy,
      input.now,
    ],
  })
}

export async function updateCommunityLocalizationMetaSourceLanguage(input: {
  executor: DbExecutor
  communityId: string
  fieldKey: string
  sourceHash: string
  sourceLanguage: string | null
  sourceLanguageConfidence: number | null
  sourceLanguageReliable: boolean
  detector: string
  detectedAt: string
}): Promise<void> {
  const sourceLanguage = normalizeDetectedSourceLanguage(input.sourceLanguage)
  const sourceLanguageReliable = input.sourceLanguageReliable === true && Boolean(sourceLanguage)
  const schema = await resolveCommunityLocalizationMetaSchema(input.executor)
  if (schema.hasLanguageDetectionColumns) {
    await input.executor.execute({
      sql: `
        UPDATE community_localization_meta
        SET source_language = ?1,
            source_language_confidence = ?2,
            source_language_reliable = ?3,
            source_language_detector = ?4,
            source_language_detected_at = ?5,
            updated_at = ?5
        WHERE community_id = ?6
          AND field_key = ?7
          AND source_hash = ?8
      `,
      args: [
        sourceLanguage,
        input.sourceLanguageConfidence,
        sourceLanguageReliable ? 1 : 0,
        input.detector,
        input.detectedAt,
        input.communityId,
        input.fieldKey,
        input.sourceHash,
      ],
    })
    return
  }

  if (!sourceLanguage) {
    return
  }

  await input.executor.execute({
    sql: `
      UPDATE community_localization_meta
      SET source_language = ?1,
          updated_at = ?2
      WHERE community_id = ?3
        AND field_key = ?4
        AND source_hash = ?5
    `,
    args: [sourceLanguage, input.detectedAt, input.communityId, input.fieldKey, input.sourceHash],
  })
}
