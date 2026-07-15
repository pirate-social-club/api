import type { Env } from "../../env"
import { enqueueCommunityJob } from "../communities/jobs/store"
import { COMMUNITY_JOB_MAX_ATTEMPTS } from "../communities/jobs/runner-types"
import { executeFirst, type DbExecutor } from "../db-helpers"
import { badRequestError, rateLimited } from "../errors"
import { makeId, nowIso } from "../helpers"
import { sameLanguageLocale } from "../localization/content-locale"
import { logPipelineError } from "../observability/pipeline-log"
import type { Client, InStatement, ReadClient } from "../sql-client"
import {
  chunkStudyGenerationLines,
  classifyStudyGenerationError,
  compactGenerationResultRef,
  orderedTranslationOptions,
  studyGenerationChunkSize,
} from "./post-study-generation-helpers"
import {
  canGenerateStudyTranslations,
  requestStudyPackGeneration,
  type StudyGeneratedLine,
} from "./post-study-generation-provider"
import {
  ensureStudyUnits,
  STUDY_UNIT_GENERATION_VERSION,
  studyWordCount,
  type StudyUnitRow,
} from "./post-study-unit-service"

// v5: regenerate translations from the punctuation-canonicalized source lines.
const STUDY_LOCALIZATION_GENERATION_VERSION = 5

type StudyGenerationRunStatus = "queued" | "running" | "ready" | "unavailable"

type StudyGenerationRun = {
  status: StudyGenerationRunStatus
}

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

type StudyGenerationPost = {
  lyrics: string | null
  post_id: string
  source_language: string | null
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
  const generationRun = await getStudyGenerationRun(input)
  if (generationRun?.status === "queued" || generationRun?.status === "running") {
    return {
      generated_at: null,
      source_language: readString(unitSummary?.source_language),
      status: "processing",
      study_pack_version: STUDY_LOCALIZATION_GENERATION_VERSION,
      target_language: input.targetLanguage,
      unavailable_reason: null,
    }
  }
  if (generationRun?.status === "unavailable") {
    return {
      generated_at: null,
      source_language: readString(unitSummary?.source_language),
      status: "unavailable",
      study_pack_version: STUDY_LOCALIZATION_GENERATION_VERSION,
      target_language: input.targetLanguage,
      unavailable_reason: "generation_failed",
    }
  }
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

async function getStudyGenerationRun(input: {
  client: DbExecutor
  postId: string
  targetLanguage: string
}): Promise<StudyGenerationRun | null> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT CASE
               WHEN r.status IN ('queued', 'running')
                AND j.status = 'failed'
                AND j.attempt_count >= ?4
               THEN 'unavailable'
               ELSE r.status
             END AS status
      FROM song_study_generation_run r
      LEFT JOIN community_jobs j ON j.job_id = r.job_id
      WHERE r.post_id = ?1
        AND r.target_language = ?2
        AND r.generation_version = ?3
      LIMIT 1
    `,
    args: [input.postId, input.targetLanguage, STUDY_LOCALIZATION_GENERATION_VERSION, COMMUNITY_JOB_MAX_ATTEMPTS],
  }) as Record<string, unknown> | null
  const status = readString(row?.status)
  if (status !== "queued" && status !== "running" && status !== "ready" && status !== "unavailable") {
    return null
  }
  return { status }
}

async function convergeStudyGenerationRun(input: {
  client: Client
  postId: string
  targetLanguage: string
}): Promise<void> {
  const now = nowIso()
  const result = await input.client.execute({
    sql: `
      UPDATE song_study_generation_run
      SET status = 'unavailable',
          error_code = COALESCE(
            (SELECT error_code FROM community_jobs WHERE job_id = song_study_generation_run.job_id),
            'generation_failed'
          ),
          completed_at = ?4,
          updated_at = ?4
      WHERE post_id = ?1
        AND target_language = ?2
        AND generation_version = ?3
        AND status IN ('queued', 'running')
        AND EXISTS (
          SELECT 1
          FROM community_jobs
          WHERE job_id = song_study_generation_run.job_id
            AND status = 'failed'
            AND attempt_count >= ?5
        )
    `,
    args: [input.postId, input.targetLanguage, STUDY_LOCALIZATION_GENERATION_VERSION, now, COMMUNITY_JOB_MAX_ATTEMPTS],
  })
  if ((result.rowsAffected ?? 0) > 0) {
    await input.client.execute({
      sql: `
        UPDATE song_study_unit_localization
        SET status = 'unavailable',
            updated_at = ?3
        WHERE target_language = ?2
          AND status = 'processing'
          AND unit_id IN (SELECT id FROM song_study_unit WHERE post_id = ?1)
      `,
      args: [input.postId, input.targetLanguage, now],
    })
  }
}

async function ensureQueuedStudyGenerationRun(input: {
  client: Client
  postId: string
  targetLanguage: string
}): Promise<void> {
  const now = nowIso()
  await input.client.execute({
    sql: `
      INSERT INTO song_study_generation_run (
        id, post_id, target_language, generation_version, status,
        attempt_count, created_at, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, 'queued', 0, ?5, ?5)
      ON CONFLICT(post_id, target_language, generation_version) DO NOTHING
    `,
    args: [makeId("sgr"), input.postId, input.targetLanguage, STUDY_LOCALIZATION_GENERATION_VERSION, now],
  })
}

export async function markStudyGenerationRunRunning(input: {
  client: Client
  jobId: string
  postId: string
  targetLanguage: string
  attemptCount: number
}): Promise<void> {
  const now = nowIso()
  await ensureQueuedStudyGenerationRun(input)
  await input.client.execute({
    sql: `
      UPDATE song_study_generation_run
      SET status = 'running',
          job_id = CASE
            WHEN EXISTS (SELECT 1 FROM community_jobs WHERE job_id = ?4) THEN ?4
            ELSE job_id
          END,
          attempt_count = ?5,
          error_code = NULL,
          completed_at = NULL,
          updated_at = ?6
      WHERE post_id = ?1
        AND target_language = ?2
        AND generation_version = ?3
        AND status IN ('queued', 'running')
    `,
    args: [input.postId, input.targetLanguage, STUDY_LOCALIZATION_GENERATION_VERSION, input.jobId, input.attemptCount, now],
  })
}

export async function completeStudyGenerationRun(input: {
  client: Client
  postId: string
  targetLanguage: string
  status: Extract<StudyGenerationRunStatus, "ready" | "unavailable">
  errorCode?: string | null
}): Promise<void> {
  const now = nowIso()
  await ensureQueuedStudyGenerationRun(input)
  await input.client.execute({
    sql: `
      UPDATE song_study_generation_run
      SET status = ?4,
          error_code = ?5,
          completed_at = ?6,
          updated_at = ?6
      WHERE post_id = ?1
        AND target_language = ?2
        AND generation_version = ?3
    `,
    args: [
      input.postId,
      input.targetLanguage,
      STUDY_LOCALIZATION_GENERATION_VERSION,
      input.status,
      input.errorCode ?? null,
      now,
    ],
  })
  if (input.status === "unavailable") {
    await input.client.execute({
      sql: `
        UPDATE song_study_unit_localization
        SET status = 'unavailable',
            updated_at = ?3
        WHERE target_language = ?2
          AND status = 'processing'
          AND unit_id IN (SELECT id FROM song_study_unit WHERE post_id = ?1)
      `,
      args: [input.postId, input.targetLanguage, now],
    })
  }
}

export async function recordStudyGenerationRunFailure(input: {
  client: Client
  errorCode: string
  postId: string
  targetLanguage: string
  terminal: boolean
}): Promise<void> {
  if (input.terminal) {
    await completeStudyGenerationRun({ ...input, status: "unavailable" })
    return
  }
  const now = nowIso()
  await input.client.execute({
    sql: `
      UPDATE song_study_generation_run
      SET status = 'queued',
          error_code = ?4,
          completed_at = NULL,
          updated_at = ?5
      WHERE post_id = ?1
        AND target_language = ?2
        AND generation_version = ?3
        AND status = 'running'
    `,
    args: [input.postId, input.targetLanguage, STUDY_LOCALIZATION_GENERATION_VERSION, input.errorCode, now],
  })
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

export async function createReadyStudyPack(input: {
  client: Client
  env: Env
  post: StudyGenerationPost
  targetLanguage: string
}): Promise<StudyPack | null> {
  const units = await ensureStudyUnits(input.client, input.post)
  if (units.length === 0) return null
  // Defensive: refuse to generate translations into the song's own language even if
  // a stale/racing caller reaches here — same-language translation is never valid.
  if (isSameLanguageStudyPair(input.post.source_language, input.targetLanguage)) return null

  const generatedLines = new Map<string, StudyGeneratedLine>()
  const generationFailureCodes: string[] = []
  const skippedGenerationReasonCodes: string[] = []
  let skippedGenerationLineCount = 0
  let failedGenerationChunks = 0
  let totalGenerationChunks = 0
  if (canGenerateStudyTranslations(input.env)) {
    const requestLines = units
      .filter((unit) => studyWordCount(unit.prompt_text) >= 3)
      .map((unit) => {
        const previous = units.find((candidate) => candidate.line_index === unit.line_index - 1)
        return {
          lineId: unit.line_id,
          previous: previous?.prompt_text ?? null,
          text: unit.prompt_text,
        }
      })
    const chunks = chunkStudyGenerationLines(requestLines, studyGenerationChunkSize(input.env))
    totalGenerationChunks = chunks.length
    for (const [chunkIndex, lines] of chunks.entries()) {
      try {
        const generated = await requestStudyPackGeneration({
          env: input.env,
          lines,
          sourceLanguage: input.post.source_language,
          targetLanguage: input.targetLanguage,
        })
        for (const line of generated.lines) {
          generatedLines.set(line.lineId, line)
        }
        if (generated.skipped.length > 0) {
          skippedGenerationLineCount += generated.skipped.length
          skippedGenerationReasonCodes.push(...generated.skipped.map((line) => line.reason))
        }
      } catch (error) {
        const errorCode = classifyStudyGenerationError(error)
        failedGenerationChunks += 1
        generationFailureCodes.push(errorCode)
        logPipelineError("[song-study] generation chunk failed", {
          chunk_index: chunkIndex,
          chunk_line_count: lines.length,
          error_code: errorCode,
          post_id: input.post.post_id,
          target_language: input.targetLanguage,
        })
      }
    }
  }

  const now = nowIso()
  const existingLocalizationRows = await input.client.execute({
    sql: `
      SELECT unit_id, localization_version, status
      FROM song_study_unit_localization
      WHERE target_language = ?1
        AND unit_id IN (${units.map(() => "?").join(", ")})
    `,
    args: [input.targetLanguage, ...units.map((unit) => unit.id)],
  })
  const existingLocalizations = new Map(existingLocalizationRows.rows.map((row) => [
    readString(row.unit_id) ?? "",
    {
      localization_version: Number(row.localization_version ?? 0),
      status: readString(row.status),
    },
  ]))
  let unavailableLineCount = 0
  const localizationStatements: InStatement[] = []
  for (const unit of units) {
    const generatedLine = generatedLines.get(unit.line_id)
    if (!generatedLine || generatedLine.distractors.length < 3) {
      unavailableLineCount += 1
      const existing = existingLocalizations.get(unit.id)
      if (existing?.status === "ready") {
        continue
      }
      localizationStatements.push({
        sql: `
          INSERT INTO song_study_unit_localization (
            id, unit_id, target_language, localization_version, status,
            max_attempts, created_at, updated_at
          )
          VALUES (?1, ?2, ?3, ?4, 'unavailable', 1, ?5, ?5)
          ON CONFLICT(unit_id, target_language) DO UPDATE SET
            localization_version = excluded.localization_version,
            status = 'unavailable',
            question = NULL,
            translation_text = NULL,
            options_json = NULL,
            correct_option_id = NULL,
            explanation_text = NULL,
            max_attempts = excluded.max_attempts,
            generated_at = NULL,
            updated_at = excluded.updated_at
        `,
        args: [makeId("sul"), unit.id, input.targetLanguage, STUDY_LOCALIZATION_GENERATION_VERSION, now],
      })
      continue
    }
    const { correctOptionId, options } = orderedTranslationOptions({
      generated: generatedLine,
      lineIndex: unit.line_index,
    })
    localizationStatements.push({
      sql: `
        INSERT INTO song_study_unit_localization (
          id, unit_id, target_language, localization_version, status,
          question, translation_text, options_json, correct_option_id,
          explanation_text, max_attempts, generated_at, created_at, updated_at
        )
        VALUES (?1, ?2, ?3, ?4, 'ready', 'Choose the best translation.', ?5, ?6, ?7, ?8, 1, ?9, ?9, ?9)
        ON CONFLICT(unit_id, target_language) DO UPDATE SET
          localization_version = excluded.localization_version,
          status = 'ready',
          question = excluded.question,
          translation_text = excluded.translation_text,
          options_json = excluded.options_json,
          correct_option_id = excluded.correct_option_id,
          explanation_text = excluded.explanation_text,
          max_attempts = excluded.max_attempts,
          generated_at = excluded.generated_at,
          updated_at = excluded.updated_at
      `,
      args: [
        makeId("sul"),
        unit.id,
        input.targetLanguage,
        STUDY_LOCALIZATION_GENERATION_VERSION,
        generatedLine.translation,
        JSON.stringify(options),
        correctOptionId,
        generatedLine.explanation ?? null,
        now,
      ],
    })
  }
  if (localizationStatements.length > 0) {
    await input.client.batch(localizationStatements, "write")
  }

  const readySummary = await executeFirst(input.client, {
    sql: `
      SELECT COUNT(*) AS ready_count
      FROM song_study_unit_localization
      WHERE target_language = ?1
        AND status = 'ready'
        AND localization_version >= ?2
        AND unit_id IN (${units.map(() => "?").join(", ")})
    `,
    args: [input.targetLanguage, STUDY_LOCALIZATION_GENERATION_VERSION, ...units.map((unit) => unit.id)],
  }) as Record<string, unknown> | null
  const hasReadyLocalization = Number(readySummary?.ready_count ?? 0) > 0

  return {
    generated_at: now,
    job_result_ref: compactGenerationResultRef({
      failedChunks: failedGenerationChunks,
      failureCodes: generationFailureCodes,
      generatedLineCount: generatedLines.size,
      skippedLineCount: skippedGenerationLineCount,
      skippedReasonCodes: skippedGenerationReasonCodes,
      targetLanguage: input.targetLanguage,
      totalChunks: totalGenerationChunks,
      unavailableLineCount,
    }),
    source_language: input.post.source_language,
    status: hasReadyLocalization ? "ready" : "unavailable",
    study_pack_version: Math.max(STUDY_UNIT_GENERATION_VERSION, STUDY_LOCALIZATION_GENERATION_VERSION),
    target_language: input.targetLanguage,
    unavailable_reason: hasReadyLocalization ? null : "generation_failed",
  }
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
  await convergeStudyGenerationRun({
    client: input.client,
    postId: input.postId,
    targetLanguage: input.targetLanguage,
  })
  const pack = await getLatestPack({
    client: input.client,
    postId: input.postId,
    targetLanguage: input.targetLanguage,
  })
  if (pack?.status === "ready" || pack?.status === "unavailable") return
  const existingRun = await getStudyGenerationRun({
    client: input.client,
    postId: input.postId,
    targetLanguage: input.targetLanguage,
  })
  if (existingRun?.status === "running") return
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
  await ensureQueuedStudyGenerationRun({
    client: input.client,
    postId: input.postId,
    targetLanguage: input.targetLanguage,
  })
  await markStudyLocalizationsProcessing({
    client: input.client,
    targetLanguage: input.targetLanguage,
    units: input.units,
  })
  const job = await enqueueCommunityJob({
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
  await input.client.execute({
    sql: `
      UPDATE song_study_generation_run
      SET job_id = ?4,
          updated_at = ?5
      WHERE post_id = ?1
        AND target_language = ?2
        AND generation_version = ?3
        AND status = 'queued'
    `,
    args: [input.postId, input.targetLanguage, STUDY_LOCALIZATION_GENERATION_VERSION, job.job_id, nowIso()],
  })
}
