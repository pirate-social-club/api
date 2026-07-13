import type { Env } from "../../env"
import { enqueueCommunityJob } from "../communities/jobs/store"
import { executeFirst, type DbExecutor } from "../db-helpers"
import { badRequestError, rateLimited } from "../errors"
import { makeId, nowIso } from "../helpers"
import { sameLanguageLocale } from "../localization/content-locale"
import type { Client, InStatement, ReadClient } from "../sql-client"
import { canGenerateStudyTranslations } from "./post-study-generation-provider"
import { STUDY_UNIT_GENERATION_VERSION, type StudyUnitRow } from "./post-study-unit-service"

// v5: regenerate translations from the punctuation-canonicalized source lines.
export const STUDY_LOCALIZATION_GENERATION_VERSION = 5

const DEFAULT_STUDY_GENERATION_TARGET_LANGUAGE_LIMIT = 3
const SUPPORTED_STUDY_TARGET_LANGUAGES = new Set([
  "ar",
  "de",
  "en",
  "es",
  "fr",
  "hi",
  "it",
  "ja",
  "ko",
  "pt",
  "zh",
])

export type StudyUnavailableReason =
  | "not_song"
  | "no_lyrics"
  | "unsupported_language"
  | "generation_failed"
  | "missing_transcription_provider"

export type StudyPack = {
  generated_at: string | null
  job_result_ref?: string | null
  source_language: string | null
  status: "ready" | "processing" | "unavailable"
  study_pack_version: number
  target_language: string
  unavailable_reason: StudyUnavailableReason | null
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed || null
}

export function normalizeStudyTargetLanguage(value: unknown): string {
  const raw = readString(value) ?? "en"
  const normalized = raw.replace(/_/gu, "-").toLowerCase()
  const primary = normalized.split("-")[0] ?? normalized
  const canonical = primary === "cmn" || primary === "yue" ? "zh" : primary
  if (!/^[a-z]{2,3}$/u.test(canonical) || !SUPPORTED_STUDY_TARGET_LANGUAGES.has(canonical)) {
    throw badRequestError("target_language is not supported")
  }
  return canonical
}

// The song-study pilot is English-source only, so a post with no reliably detected
// source_language is assumed English for the same-language decision below. Without
// this, an English song whose source_language is null/undetected takes the
// cross-language path and gets degenerate English->English "translation" MCQs (the
// same failure the strict guard fixes for explicitly-English posts).
const ASSUMED_STUDY_SOURCE_LANGUAGE = "en"

// Translation-choice exercises only make sense when the learner's target language
// differs from the song's source language. When they coincide (e.g. an English
// speaker studying an English song) "translate this line" collapses into paraphrase
// and actively mis-teaches (there is no correct answer), so we suppress translation
// generation AND serving and fall back to say-it-back (source-language recall) only.
// Locale-aware via sameLanguageLocale so en-US / en_GB source vs. en target count as
// the same language. A null/unknown source_language falls back to the pilot's assumed
// English source, so it suppresses only for an English target and still offers real
// translations into other languages. NOTE: this cannot rescue a source_language that
// is confidently WRONG (e.g. English lyrics mislabeled "tr") — that is a data-quality
// problem the source_language must be corrected for; revisit the assumption when study
// expands beyond English-source songs.
export function isSameLanguageStudyPair(sourceLanguage: string | null | undefined, targetLanguage: string): boolean {
  return sameLanguageLocale(readString(sourceLanguage) ?? ASSUMED_STUDY_SOURCE_LANGUAGE, targetLanguage)
}

function parsePositiveInteger(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function resolveStudyGenerationTargetLanguageLimit(env: Env): number {
  return parsePositiveInteger(env.SONG_STUDY_GENERATION_TARGET_LANGUAGE_LIMIT)
    ?? DEFAULT_STUDY_GENERATION_TARGET_LANGUAGE_LIMIT
}

async function enforceStudyGenerationTargetLanguageLimit(input: {
  client: ReadClient
  env: Env
  postId: string
  targetLanguage: string
}): Promise<void> {
  const limit = resolveStudyGenerationTargetLanguageLimit(input.env)
  const row = await executeFirst(input.client, {
    sql: `
      SELECT COUNT(DISTINCT l.target_language) AS language_count,
             SUM(CASE WHEN l.target_language = ?2 THEN 1 ELSE 0 END) AS requested_count
      FROM song_study_unit_localization l
      JOIN song_study_unit u ON u.id = l.unit_id
      WHERE u.post_id = ?1
    `,
    args: [input.postId, input.targetLanguage],
  }) as Record<string, unknown> | null
  if (Number(row?.requested_count ?? 0) > 0) return
  if (Number(row?.language_count ?? 0) >= limit) {
    throw rateLimited("Song study translation generation limit exceeded", {
      limit,
      scope: "post_target_languages",
    })
  }
}

export async function getLatestPack(input: {
  client: DbExecutor
  postId: string
  targetLanguage: string
}): Promise<StudyPack | null> {
  const unitSummary = await executeFirst(input.client, {
    sql: `
      SELECT COUNT(*) AS unit_count,
             MAX(source_language) AS source_language,
             MAX(unit_version) AS unit_version
      FROM song_study_unit
      WHERE post_id = ?1
    `,
    args: [input.postId],
  }) as Record<string, unknown> | null
  const unitCount = Number(unitSummary?.unit_count ?? 0)
  if (unitCount <= 0) return null
  const localizationSummary = await executeFirst(input.client, {
    sql: `
      SELECT COUNT(*) AS localization_count,
             MAX(generated_at) AS generated_at,
             MIN(localization_version) AS min_localization_version,
             MAX(localization_version) AS max_localization_version,
             SUM(CASE WHEN status = 'ready' THEN 1 ELSE 0 END) AS ready_count,
             SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing_count
      FROM song_study_unit_localization
      WHERE target_language = ?1
        AND unit_id IN (
          SELECT id FROM song_study_unit WHERE post_id = ?2
        )
    `,
    args: [input.targetLanguage, input.postId],
  }) as Record<string, unknown> | null
  const localizationCount = Number(localizationSummary?.localization_count ?? 0)
  const minLocalizationVersion = Number(localizationSummary?.min_localization_version ?? 0)
  if (localizationCount < unitCount || minLocalizationVersion < STUDY_LOCALIZATION_GENERATION_VERSION) {
    return null
  }
  const processingCount = Number(localizationSummary?.processing_count ?? 0)
  return {
    generated_at: readString(localizationSummary?.generated_at),
    source_language: readString(unitSummary?.source_language),
    status: processingCount > 0 ? "processing" : "ready",
    study_pack_version: Math.max(
      Number(unitSummary?.unit_version ?? STUDY_UNIT_GENERATION_VERSION),
      Number(localizationSummary?.max_localization_version ?? STUDY_LOCALIZATION_GENERATION_VERSION),
    ),
    target_language: input.targetLanguage,
    unavailable_reason: null,
  }
}

export async function hasCompleteReadyStudyLocalizations(input: {
  client: ReadClient
  postId: string
  targetLanguage: string
}): Promise<boolean> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT COUNT(u.id) AS unit_count,
             SUM(CASE
               WHEN l.status = 'ready'
                AND l.localization_version >= ?3
                AND l.translation_text IS NOT NULL
                AND l.options_json IS NOT NULL
                AND l.correct_option_id IS NOT NULL
               THEN 1 ELSE 0 END) AS ready_count
      FROM song_study_unit u
      LEFT JOIN song_study_unit_localization l
        ON l.unit_id = u.id
       AND l.target_language = ?2
      WHERE u.post_id = ?1
    `,
    args: [input.postId, input.targetLanguage, STUDY_LOCALIZATION_GENERATION_VERSION],
  }) as Record<string, unknown> | null
  const unitCount = Number(row?.unit_count ?? 0)
  return unitCount > 0 && Number(row?.ready_count ?? 0) >= unitCount
}

async function markStudyLocalizationsProcessing(input: {
  client: Client
  targetLanguage: string
  units: StudyUnitRow[]
}): Promise<void> {
  const now = nowIso()
  const statements = input.units.map((unit): InStatement => ({
    sql: `
        INSERT INTO song_study_unit_localization (
          id, unit_id, target_language, localization_version, status,
          max_attempts, created_at, updated_at
        )
        VALUES (?1, ?2, ?3, ?4, 'processing', 1, ?5, ?5)
        ON CONFLICT(unit_id, target_language) DO UPDATE SET
          localization_version = excluded.localization_version,
          status = CASE
            WHEN song_study_unit_localization.status IN ('ready', 'unavailable')
             AND song_study_unit_localization.localization_version >= excluded.localization_version
            THEN song_study_unit_localization.status
            ELSE 'processing'
          END,
          max_attempts = excluded.max_attempts,
          updated_at = excluded.updated_at
      `,
    args: [makeId("sul"), unit.id, input.targetLanguage, STUDY_LOCALIZATION_GENERATION_VERSION, now],
  }))
  if (statements.length > 0) {
    await input.client.batch(statements, "write")
  }
}

export async function enqueueStudyGenerationIfNeeded(input: {
  client: Client
  communityId: string
  env: Env
  postId: string
  sourceLanguage: string | null
  targetLanguage: string
  units: StudyUnitRow[]
}): Promise<void> {
  if (!canGenerateStudyTranslations(input.env)) return
  if (input.units.length === 0) return
  if (isSameLanguageStudyPair(input.sourceLanguage, input.targetLanguage)) return
  const pack = await getLatestPack({
    client: input.client,
    postId: input.postId,
    targetLanguage: input.targetLanguage,
  })
  if (pack?.status === "ready") return
  if (await hasCompleteReadyStudyLocalizations({
    client: input.client,
    postId: input.postId,
    targetLanguage: input.targetLanguage,
  })) {
    return
  }
  await enforceStudyGenerationTargetLanguageLimit({
    client: input.client,
    env: input.env,
    postId: input.postId,
    targetLanguage: input.targetLanguage,
  })
  await markStudyLocalizationsProcessing({
    client: input.client,
    targetLanguage: input.targetLanguage,
    units: input.units,
  })
  await enqueueCommunityJob({
    client: input.client,
    communityId: input.communityId,
    jobType: "song_study_generate",
    subjectType: "post_study",
    subjectId: `${input.postId}:${input.targetLanguage}`,
    payloadJson: JSON.stringify({
      post_id: input.postId,
      target_language: input.targetLanguage,
    }),
    createdAt: nowIso(),
  })
}
