import type { DbExecutor } from "../db-helpers"
import { makeId } from "../helpers"
import { requiredString, rowValue, stringOrNull } from "../sql-row"

export type CommunityLocalizationTranslationPolicy = "none" | "machine_allowed" | "human_only" | "hybrid"

export type CommunityLocalizationMetaRecord = {
  community_localization_meta_id: string
  community_id: string
  field_key: string
  source_hash: string
  source_language: string | null
  translation_policy: CommunityLocalizationTranslationPolicy
  created_at: string
  updated_at: string
}

function toCommunityLocalizationMetaRecord(row: unknown): CommunityLocalizationMetaRecord {
  return {
    community_localization_meta_id: requiredString(row, "community_localization_meta_id"),
    community_id: requiredString(row, "community_id"),
    field_key: requiredString(row, "field_key"),
    source_hash: requiredString(row, "source_hash"),
    source_language: stringOrNull(rowValue(row, "source_language")),
    translation_policy: requiredString(row, "translation_policy") as CommunityLocalizationTranslationPolicy,
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export async function listCommunityLocalizationMeta(input: {
  executor: DbExecutor
  communityId: string
}): Promise<Map<string, CommunityLocalizationMetaRecord>> {
  const result = await input.executor.execute({
    sql: `
      SELECT community_localization_meta_id, community_id, field_key, source_hash,
             source_language, translation_policy, created_at, updated_at
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

export async function upsertCommunityLocalizationMeta(input: {
  executor: DbExecutor
  communityId: string
  fieldKey: string
  sourceHash: string
  sourceLanguage?: string | null
  translationPolicy: CommunityLocalizationTranslationPolicy
  now: string
}): Promise<void> {
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
      input.sourceLanguage ?? null,
      input.translationPolicy,
      input.now,
    ],
  })
}
