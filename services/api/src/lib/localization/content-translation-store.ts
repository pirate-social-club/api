import type { DbExecutor } from "../db-helpers"
import { executeFirst } from "../db-helpers"
import { makeId } from "../helpers"
import { requiredString, rowValue, stringOrNull } from "../sql-row"

export type LocalizedContentType = "post" | "comment"
export type ContentTranslationOutcome = "translated" | "same_language"

export type ContentTranslationRecord = {
  content_translation_id: string
  content_type: LocalizedContentType
  content_id: string
  locale: string
  source_hash: string
  source_language: string | null
  outcome: ContentTranslationOutcome
  translated_title: string | null
  translated_body: string | null
  translated_caption: string | null
  provider: string | null
  provider_model: string | null
  provider_result_json: string | null
  created_at: string
  updated_at: string
}

function toContentTranslationRecord(row: unknown): ContentTranslationRecord {
  return {
    content_translation_id: requiredString(row, "content_translation_id"),
    content_type: requiredString(row, "content_type") as LocalizedContentType,
    content_id: requiredString(row, "content_id"),
    locale: requiredString(row, "locale"),
    source_hash: requiredString(row, "source_hash"),
    source_language: stringOrNull(rowValue(row, "source_language")),
    outcome: requiredString(row, "outcome") as ContentTranslationOutcome,
    translated_title: stringOrNull(rowValue(row, "translated_title")),
    translated_body: stringOrNull(rowValue(row, "translated_body")),
    translated_caption: stringOrNull(rowValue(row, "translated_caption")),
    provider: stringOrNull(rowValue(row, "provider")),
    provider_model: stringOrNull(rowValue(row, "provider_model")),
    provider_result_json: stringOrNull(rowValue(row, "provider_result_json")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export async function getContentTranslation(input: {
  executor: DbExecutor
  contentType: LocalizedContentType
  contentId: string
  locale: string
  sourceHash: string
}): Promise<ContentTranslationRecord | null> {
  const row = await executeFirst(input.executor, {
    sql: `
      SELECT content_translation_id, content_type, content_id, locale, source_hash,
             source_language, outcome, translated_title, translated_body, translated_caption, provider,
             provider_model, provider_result_json, created_at, updated_at
      FROM content_translations
      WHERE content_type = ?1
        AND content_id = ?2
        AND locale = ?3
        AND source_hash = ?4
      LIMIT 1
    `,
    args: [input.contentType, input.contentId, input.locale, input.sourceHash],
  })

  return row ? toContentTranslationRecord(row) : null
}

export async function upsertContentTranslation(input: {
  executor: DbExecutor
  contentType: LocalizedContentType
  contentId: string
  locale: string
  sourceHash: string
  sourceLanguage?: string | null
  outcome: ContentTranslationOutcome
  translatedTitle?: string | null
  translatedBody?: string | null
  translatedCaption?: string | null
  provider?: string | null
  providerModel?: string | null
  providerResultJson?: string | null
  now: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      INSERT INTO content_translations (
        content_translation_id, content_type, content_id, locale, source_hash,
        source_language, outcome, translated_title, translated_body, translated_caption, provider,
        provider_model, provider_result_json, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5,
        ?6, ?7, ?8, ?9, ?10, ?11,
        ?12, ?13, ?14, ?14
      )
      ON CONFLICT(content_type, content_id, locale, source_hash) DO UPDATE SET
        source_language = excluded.source_language,
        outcome = excluded.outcome,
        translated_title = excluded.translated_title,
        translated_body = excluded.translated_body,
        translated_caption = excluded.translated_caption,
        provider = excluded.provider,
        provider_model = excluded.provider_model,
        provider_result_json = excluded.provider_result_json,
        updated_at = excluded.updated_at
    `,
    args: [
      makeId("ctr"),
      input.contentType,
      input.contentId,
      input.locale,
      input.sourceHash,
      input.sourceLanguage ?? null,
      input.outcome,
      input.translatedTitle ?? null,
      input.translatedBody ?? null,
      input.translatedCaption ?? null,
      input.provider ?? null,
      input.providerModel ?? null,
      input.providerResultJson ?? null,
      input.now,
    ],
  })
}
