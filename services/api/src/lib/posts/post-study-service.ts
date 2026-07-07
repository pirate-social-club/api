import type { ActorContext, AdminActorContext } from "../auth-middleware"
import type { Env } from "../../env"
import type { Profile } from "../../types"
import type { ProfileRepository } from "../auth/repositories"
import { badRequestError, conflictError, HttpError, notFoundError, rateLimited } from "../errors"
import { executeFirst } from "../db-helpers"
import { envFlag, makeId, nowIso } from "../helpers"
import type { Client, ReadClient } from "../sql-client"
import { getActiveEntitlementForBuyer } from "../communities/commerce/shared"
import { enqueueCommunityJob } from "../communities/jobs/store"
import type { CommunityJobHandlerInput } from "../communities/jobs/handler-types"
import { parseJobPayload } from "../communities/jobs/payload"
import { isCommunityStudyEnabled } from "../communities/community-study-policy-service"
import type { CommunityDatabaseBindingRepository } from "../communities/community-repository-types"
import { openCommunityWriteClient } from "../communities/community-read-access"
import {
  getCommunityElevenLabsStudyCapability,
  type CommunityElevenLabsStudyCapability,
} from "../communities/assistant-policy/credential-service"
import { transcribeCommunityAudioWithElevenLabs } from "../communities/assistant-policy/speech-service"
import { canGenerateStudyTranslations, requestStudyPackGeneration, type StudyGeneratedLine } from "./post-study-generation-provider"
import { canReadNonPublishedPost, isPubliclyReadablePost, requireMemberAccess } from "./post-access"
import { publicCommunityId, publicPostId } from "../public-ids"
import { withTransaction } from "../transactions"
import { logPipelineError } from "../observability/pipeline-log"
import { sameLanguageLocale } from "../localization/content-locale"
import { rowValue } from "../sql-row"

type StudyAccess = "ready" | "locked" | "processing" | "unavailable"
type ExerciseType = "say_it_back" | "translation_choice"
type AttemptOutcome = "correct" | "incorrect" | "revealed"
type FsrsRating = "again" | "hard" | "good" | "easy"

// v2: strip trailing line punctuation at unit creation (see stripTrailingLinePunctuation)
// — bumping this forces existing units to be re-split so stored text is canonicalized.
const STUDY_UNIT_GENERATION_VERSION = 2
// v5: regenerate translations from the punctuation-canonicalized source lines.
const STUDY_LOCALIZATION_GENERATION_VERSION = 5
const FSRS_PARAMS_VERSION = 1
const DEFAULT_STUDY_GENERATION_TARGET_LANGUAGE_LIMIT = 3
const DEFAULT_STUDY_GENERATION_CHUNK_SIZE = 10
const STREAK_MIN_STUDY_ATTEMPTS = 10
const STREAK_LEADERBOARD_DEFAULT_LIMIT = 50
const STREAK_LEADERBOARD_MAX_LIMIT = 100
const STREAK_LEADERBOARD_OVERFETCH = 25
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

type StudyPost = {
  access_mode: "public" | "locked" | null
  asset_id: string | null
  author_user_id: string | null
  community_id: string
  lyrics: string | null
  post_id: string
  post_type: string
  song_cover_art_ref: string | null
  song_title: string | null
  source_language: string | null
  status: string
  title: string | null
  visibility: string
}

type StudyPack = {
  generated_at: string | null
  job_result_ref?: string | null
  source_language: string | null
  status: "ready" | "processing" | "unavailable"
  study_pack_version: number
  target_language: string
  unavailable_reason: StudyUnavailableReason | null
}

type StudyUnavailableReason =
  | "not_song"
  | "no_lyrics"
  | "unsupported_language"
  | "generation_failed"
  | "missing_transcription_provider"

type StudyExerciseRow = {
  correct_option_id: string | null
  exercise_type: ExerciseType
  id: string
  line_id: string
  line_index: number
  max_attempts: number
  options_json: string | null
  prompt_text: string
  question: string | null
  reference_text: string | null
  review_language: string
  study_pack_version: number
  translation_text: string | null
}

type StudyUnitRow = {
  id: string
  line_id: string
  line_index: number
  max_attempts: number
  prompt_text: string
  reference_text: string
  say_it_back_status: "ready" | "unavailable"
  source_language: string | null
  unit_version: number
}

type StudyAttemptRow = {
  attempt_number: number
  exercise_id: string
  feedback_json: string | null
  fsrs_rating: FsrsRating | null
  outcome: AttemptOutcome
  selected_option_id: string | null
  transcript: string | null
  type: ExerciseType
}

type StudyReviewStateRow = {
  difficulty: number
  due_at: string
  lapses: number
  reps: number
  stability: number
  state: "new" | "learning" | "review" | "relearning"
}

type StudyReviewSchedule = {
  difficulty: number
  dueAt: string
  lapseIncrement: 0 | 1
  stability: number
  state: StudyReviewStateRow["state"]
}

export type SongStudyExercise =
  | {
      id: string
      line_id: string
      line_index: number
      max_attempts: number
      prompt_text: string
      reference_text: string
      translation_text?: string | null
      type: "say_it_back"
    }
  | {
      id: string
      line_id: string
      line_index: number
      max_attempts: number
      options: Array<{ id: string; text: string }>
      prompt_text: string
      question: string
      type: "translation_choice"
    }

export type SongStudySessionSummary = {
  due_count: number
  next_due_at?: number
  served_count: number
  total_units: number
}

export type SongStudyPayload = {
  access: StudyAccess
  artist_name?: string | null
  artwork_src?: string | null
  community_id: string
  exercise_count: number
  exercises: SongStudyExercise[]
  generated_at?: number
  locked_reason?: "purchase_required" | "membership_required" | "age_required"
  object: "song_study_payload"
  post_id: string
  session?: SongStudySessionSummary
  source_language?: string | null
  study_pack_version?: number
  target_language?: string | null
  title: string
  unavailable_reason?: StudyUnavailableReason
}

export type SongStudyAttemptRequest = {
  attempt_number?: unknown
  exercise_id?: unknown
  idempotency_key?: unknown
  selected_option_id?: unknown
  target_language?: unknown
  transcript?: unknown
  type?: unknown
}

export type SongStudyAttemptResult = {
  attempts_remaining: number
  correct_option_id?: string
  exercise_id: string
  feedback?: {
    matched: string[]
    missing: string[]
    extra: string[]
  }
  next_review_hint?: FsrsRating
  object: "song_study_attempt_result"
  outcome: AttemptOutcome
  study_progress?: SongStudyAttemptProgress
}

export type SongStudyAttemptProgress = {
  current_streak: number
  next_due_at?: number
  qualified_today: boolean
  study_attempt_count: number
  study_correct_count: number
  study_target_count: number
}

export type SongStudyAttemptTiming = {
  access_read_batch_ms?: number
  close_client_ms?: number
  credential_probe_ms?: number
  credential_source?: CommunityElevenLabsStudyCapability["source"]
  community_id: string
  due_review_count_ms?: number
  exercise_id: string
  exercise_type?: ExerciseType
  open_client_ms?: number
  outcome: string
  parallel_read_batch_ms?: number
  post_id: string
  streak_target_count_ms?: number
  streak_deferred: boolean
  streak_inline_ms?: number
  streak_writes_enabled: boolean
  total_ms: number
  wait_until_available: boolean
  write_tx_ms?: number
}

const SONG_STUDY_ATTEMPT_TIMING = Symbol("songStudyAttemptTiming")

export function getSongStudyAttemptTiming(result: SongStudyAttemptResult): SongStudyAttemptTiming | undefined {
  return (result as SongStudyAttemptResult & { [SONG_STUDY_ATTEMPT_TIMING]?: SongStudyAttemptTiming })[SONG_STUDY_ATTEMPT_TIMING]
}

export type SongStudyTranscriptionResponse = {
  confidence: number | null
  duration_seconds: number | null
  language_code: string | null
  language_probability: number | null
  model: string
  object: "song_study_transcription"
  provider: "elevenlabs"
  text: string
}

export type SongStreakLeaderboardIdentity = {
  avatar_ref?: string | null
  display_name?: string | null
  handle?: string | null
  user_id: string
}

export type SongStreakLeaderboardEntry = {
  best_streak: number
  current_streak: number
  identity: SongStreakLeaderboardIdentity
  is_viewer: boolean
  last_qualified_date: string
  rank: number
  streak_started_date: string
  total_qualified_days: number
}

export type SongStreakViewerStanding = {
  alive: boolean
  best_streak: number
  current_streak: number
  karaoke_passed_today: boolean
  qualified_today: boolean
  study_attempts_today: number
  study_target_today: number
  total_qualified_days: number
}

export type SongStreakLeaderboard = {
  community_id: string
  date: string
  entries: SongStreakLeaderboardEntry[]
  object: "song_streak_leaderboard"
  post_id: string
  total_active_streaks: number
  viewer: SongStreakViewerStanding | null
}

export type SongStreakSummary = {
  entries: SongStreakLeaderboardEntry[]
  total_active_streaks: number
  viewer: SongStreakViewerStanding | null
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed || null
}

function classifyStudyGenerationError(error: unknown): string {
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

function compactGenerationResultRef(input: {
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
    return [
      "ready",
      input.targetLanguage,
      ...diagnosticParts,
    ].filter(Boolean).join(":")
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

function chunkArray<T>(items: T[], chunkSize: number): T[][] {
  const chunks: T[][] = []
  for (let index = 0; index < items.length; index += chunkSize) {
    chunks.push(items.slice(index, index + chunkSize))
  }
  return chunks
}

function studyGenerationChunkSize(env: Env): number {
  const configured = Number(env.OPENROUTER_STUDY_GENERATION_CHUNK_SIZE ?? "")
  if (Number.isInteger(configured) && configured > 0) {
    return Math.min(configured, 25)
  }
  return DEFAULT_STUDY_GENERATION_CHUNK_SIZE
}

function readRequiredString(value: unknown, field: string): string {
  const trimmed = readString(value)
  if (!trimmed) throw badRequestError(`${field} is required`)
  return trimmed
}

function parsePositiveInteger(value: string | null | undefined): number | null {
  if (!value) return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

function normalizeStudyTargetLanguage(value: unknown): string {
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
function isSameLanguageStudyPair(sourceLanguage: string | null | undefined, targetLanguage: string): boolean {
  return sameLanguageLocale(readString(sourceLanguage) ?? ASSUMED_STUDY_SOURCE_LANGUAGE, targetLanguage)
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

function readAttemptNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw badRequestError("attempt_number must be a positive integer")
  }
  return value
}

function publicTitle(post: StudyPost): string {
  return post.song_title || post.title || "Untitled song"
}

function toUnixSeconds(value: string | null): number | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined
}

function dueReviewServingEnabled(env: Env): boolean {
  return envFlag(env.SONG_STUDY_DUE_REVIEW_SERVING_ENABLED, false)
}

function studyStreakWritesEnabled(env: Env): boolean {
  return envFlag(env.SONG_STUDY_STREAK_WRITES_ENABLED, false)
}

function studyAttemptTimingLogsEnabled(env: Env): boolean {
  return envFlag(env.SONG_STUDY_ATTEMPT_TIMING_LOGS, false)
}

function elapsedMs(start: number): number {
  return Math.round((performance.now() - start) * 10) / 10
}

function isDueReview(input: { dueAt: string; now: string }): boolean {
  const dueAtMs = Date.parse(input.dueAt)
  const nowMs = Date.parse(input.now)
  return Number.isFinite(dueAtMs) && Number.isFinite(nowMs) && dueAtMs <= nowMs
}

function studyTargetCountFromDueBefore(dueBefore: number): number {
  return dueBefore > 0 ? Math.min(STREAK_MIN_STUDY_ATTEMPTS, dueBefore) : STREAK_MIN_STUDY_ATTEMPTS
}

function studyTargetCountFromServeableExerciseCount(exerciseCount: number): number {
  return Math.max(1, Math.min(STREAK_MIN_STUDY_ATTEMPTS, exerciseCount))
}

async function getStudyPostById(client: ReadClient, postId: string): Promise<StudyPost | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT post_id, community_id, author_user_id, post_type, status, visibility,
             lyrics,
             title, song_title, song_cover_art_ref, source_language, access_mode, asset_id
      FROM posts
      WHERE post_id = ?1
      LIMIT 1
    `,
    args: [postId],
  }) as Record<string, unknown> | null
  if (!row) return null
  return {
    access_mode: readString(row.access_mode) as StudyPost["access_mode"],
    asset_id: readString(row.asset_id),
    author_user_id: readString(row.author_user_id),
    community_id: readString(row.community_id) ?? "",
    lyrics: readString(row.lyrics),
    post_id: readString(row.post_id) ?? "",
    post_type: readString(row.post_type) ?? "",
    song_cover_art_ref: readString(row.song_cover_art_ref),
    song_title: readString(row.song_title),
    source_language: readString(row.source_language),
    status: readString(row.status) ?? "",
    title: readString(row.title),
    visibility: readString(row.visibility) ?? "public",
  }
}

async function canReadPostForStudy(input: {
  actor: ActorContext | AdminActorContext
  client: ReadClient
  post: StudyPost
}): Promise<boolean> {
  if (isPubliclyReadablePost({
    status: input.post.status as "draft" | "published" | "hidden" | "removed" | "deleted",
    visibility: input.post.visibility as "public" | "members_only",
  })) {
    return true
  }
  try {
    const membership = await requireMemberAccess(input.client as Client, input.post.community_id, input.actor.userId)
    return input.post.status === "published"
      || canReadNonPublishedPost({ author_user_id: input.post.author_user_id }, membership, input.actor.userId)
  } catch {
    return isPubliclyReadablePost({
      status: input.post.status as "draft" | "published" | "hidden" | "removed" | "deleted",
      visibility: input.post.visibility as "public" | "members_only",
    })
  }
}

async function canStudyPost(input: {
  actor: ActorContext | AdminActorContext
  client: ReadClient
  communityId: string
  post: StudyPost
}): Promise<boolean> {
  if (input.post.access_mode !== "locked") return true
  if (input.post.author_user_id === input.actor.userId) return true
  if (!input.post.asset_id) return false
  const entitlement = await getActiveEntitlementForBuyer(
    input.client,
    input.communityId,
    input.actor.userId,
    input.post.asset_id,
    "asset_access",
  )
  return Boolean(entitlement)
}

async function getLatestPack(input: {
  client: ReadClient
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

function parseOptions(raw: string | null): Array<{ id: string; text: string }> {
  if (!raw) return []
  const parsed = JSON.parse(raw) as unknown
  if (!Array.isArray(parsed)) return []
  return parsed.flatMap((option) => {
    if (!option || typeof option !== "object") return []
    const record = option as Record<string, unknown>
    const id = readString(record.id)
    const text = readString(record.text)
    return id && text ? [{ id, text }] : []
  })
}

function stableHash(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function orderOptionsForLearner(options: Array<{ id: string; text: string }>, seed: string): Array<{ id: string; text: string }> {
  return [...options].sort((left, right) => {
    const leftRank = stableHash(`${seed}:${left.id}`)
    const rightRank = stableHash(`${seed}:${right.id}`)
    return leftRank - rightRank || left.id.localeCompare(right.id)
  })
}

function toExercise(row: StudyExerciseRow, learnerSeed: string): SongStudyExercise {
  if (row.exercise_type === "translation_choice") {
    return {
      id: row.id,
      line_id: row.line_id,
      line_index: row.line_index,
      max_attempts: row.max_attempts,
      options: orderOptionsForLearner(parseOptions(row.options_json), `${learnerSeed}:${row.id}`),
      prompt_text: row.prompt_text,
      question: row.question || "Choose the best translation.",
      type: "translation_choice",
    }
  }
  return {
    id: row.id,
    line_id: row.line_id,
    line_index: row.line_index,
    max_attempts: row.max_attempts,
    prompt_text: row.prompt_text,
    reference_text: row.reference_text || row.prompt_text,
    translation_text: row.translation_text,
    type: "say_it_back",
  }
}

async function listExercises(input: {
  client: ReadClient
  dueReviewServing: boolean
  includeSayItBack: boolean
  includeTranslation: boolean
  now: string
  postId: string
  targetLanguage: string
  userId?: string | null
}): Promise<StudyExerciseRow[]> {
  const result = await input.client.execute({
    sql: `
      SELECT ('stu:' || u.id || ':say_it_back:' || COALESCE(u.source_language, 'source')) AS id,
             u.line_id, u.line_index, 'say_it_back' AS exercise_type, u.prompt_text,
             NULL AS question, u.reference_text, NULL AS translation_text,
             NULL AS options_json, NULL AS correct_option_id, u.max_attempts,
             COALESCE(u.source_language, 'source') AS review_language, u.unit_version AS study_pack_version,
             0 AS sort_order
      FROM song_study_unit u
      LEFT JOIN song_study_review_state s
        ON s.user_id = ?5
       AND s.post_id = u.post_id
       AND s.line_id = u.line_id
       AND s.exercise_type = 'say_it_back'
       AND s.target_language = COALESCE(u.source_language, 'source')
      WHERE u.post_id = ?1
        AND u.say_it_back_status = 'ready'
        AND ?3 = 1
        AND (
          ?5 IS NULL
          OR s.user_id IS NULL
          OR (?6 = 1 AND s.due_at <= ?7)
        )
      UNION ALL
      SELECT ('stu:' || u.id || ':translation_choice:' || l.target_language) AS id,
             u.line_id, u.line_index, 'translation_choice' AS exercise_type,
             u.prompt_text, l.question, NULL AS reference_text, l.translation_text,
             l.options_json, l.correct_option_id, l.max_attempts,
             l.target_language AS review_language,
             l.localization_version AS study_pack_version,
             1 AS sort_order
      FROM song_study_unit u
      JOIN song_study_unit_localization l ON l.unit_id = u.id
      LEFT JOIN song_study_review_state s
        ON s.user_id = ?5
       AND s.post_id = u.post_id
       AND s.line_id = u.line_id
       AND s.exercise_type = 'translation_choice'
       AND s.target_language = l.target_language
      WHERE u.post_id = ?1
        AND ?4 = 1
        AND l.target_language = ?2
        AND l.status = 'ready'
        AND l.translation_text IS NOT NULL
        AND l.options_json IS NOT NULL
        AND l.correct_option_id IS NOT NULL
        AND (
          ?5 IS NULL
          OR s.user_id IS NULL
          OR (?6 = 1 AND s.due_at <= ?7)
        )
      ORDER BY line_index ASC, sort_order ASC, id ASC
    `,
    args: [
      input.postId,
      input.targetLanguage,
      input.includeSayItBack ? 1 : 0,
      input.includeTranslation ? 1 : 0,
      input.userId ?? null,
      input.dueReviewServing ? 1 : 0,
      input.now,
    ],
  })
  return result.rows.map((row) => ({
    correct_option_id: readString(row.correct_option_id),
    exercise_type: (readString(row.exercise_type) ?? "say_it_back") as ExerciseType,
    id: readString(row.id) ?? "",
    line_id: readString(row.line_id) ?? "",
    line_index: Number(row.line_index ?? 0),
    max_attempts: Number(row.max_attempts ?? 1),
    options_json: readString(row.options_json),
    prompt_text: readString(row.prompt_text) ?? "",
    question: readString(row.question),
    reference_text: readString(row.reference_text),
    review_language: readString(row.review_language) ?? input.targetLanguage,
    study_pack_version: Number(row.study_pack_version ?? 1),
    translation_text: readString(row.translation_text),
  }))
}

async function countDueReviewExercises(input: {
  client: ReadClient
  includeSayItBack: boolean
  includeTranslation: boolean
  now: string
  postId: string
  targetLanguage: string
  userId: string
}): Promise<number> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT COUNT(*) AS count
      FROM (
        SELECT s.due_at
        FROM song_study_review_state s
        JOIN song_study_unit u
          ON u.post_id = s.post_id
         AND u.line_id = s.line_id
        WHERE s.user_id = ?1
          AND s.post_id = ?2
          AND s.exercise_type = 'say_it_back'
          AND s.target_language = COALESCE(u.source_language, 'source')
          AND s.due_at <= ?4
          AND u.say_it_back_status = 'ready'
          AND ?5 = 1
        UNION ALL
        SELECT s.due_at
        FROM song_study_review_state s
        JOIN song_study_unit u
          ON u.post_id = s.post_id
         AND u.line_id = s.line_id
        JOIN song_study_unit_localization l
          ON l.unit_id = u.id
         AND l.target_language = s.target_language
        WHERE s.user_id = ?1
          AND s.post_id = ?2
          AND s.exercise_type = 'translation_choice'
          AND s.target_language = ?3
          AND s.due_at <= ?4
          AND ?6 = 1
          AND l.status = 'ready'
          AND l.translation_text IS NOT NULL
          AND l.options_json IS NOT NULL
          AND l.correct_option_id IS NOT NULL
      )
    `,
    args: [
      input.userId,
      input.postId,
      input.targetLanguage,
      input.now,
      input.includeSayItBack ? 1 : 0,
      input.includeTranslation ? 1 : 0,
    ],
  }) as Record<string, unknown> | null
  return Number(row?.count ?? 0)
}

async function getNextDueAt(input: {
  client: ReadClient
  includeSayItBack: boolean
  includeTranslation: boolean
  now: string
  postId: string
  targetLanguage: string
  userId: string
}): Promise<string | null> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT MIN(due_at) AS next_due_at
      FROM (
        SELECT s.due_at
        FROM song_study_review_state s
        JOIN song_study_unit u
          ON u.post_id = s.post_id
         AND u.line_id = s.line_id
        WHERE s.user_id = ?1
          AND s.post_id = ?2
          AND s.exercise_type = 'say_it_back'
          AND s.target_language = COALESCE(u.source_language, 'source')
          AND s.due_at > ?4
          AND u.say_it_back_status = 'ready'
          AND ?5 = 1
        UNION ALL
        SELECT s.due_at
        FROM song_study_review_state s
        JOIN song_study_unit u
          ON u.post_id = s.post_id
         AND u.line_id = s.line_id
        JOIN song_study_unit_localization l
          ON l.unit_id = u.id
         AND l.target_language = s.target_language
        WHERE s.user_id = ?1
          AND s.post_id = ?2
          AND s.exercise_type = 'translation_choice'
          AND s.target_language = ?3
          AND s.due_at > ?4
          AND ?6 = 1
          AND l.status = 'ready'
          AND l.translation_text IS NOT NULL
          AND l.options_json IS NOT NULL
          AND l.correct_option_id IS NOT NULL
      )
    `,
    args: [
      input.userId,
      input.postId,
      input.targetLanguage,
      input.now,
      input.includeSayItBack ? 1 : 0,
      input.includeTranslation ? 1 : 0,
    ],
  }) as Record<string, unknown> | null
  return readString(row?.next_due_at)
}

function studyLineId(index: number): string {
  return `line_${String(index + 1).padStart(3, "0")}`
}

function isPureAdLib(line: string): boolean {
  return /^\s*\([^)]+\)\s*$/u.test(line)
}

function stripTrailingAdLibs(line: string): string {
  return line.replace(/\s*\([^)]*\)\s*$/u, "").trim()
}

// Lyrics are one sentence split across lines, so lines routinely end in a comma
// (or period / semicolon / colon / dash) that reads as a wart when shown as a
// say-it-back reference or fed to the translation model. Drop that trailing
// punctuation for clean display + clean LLM input, but keep a trailing ? or !
// (they change how the line reads) and never touch internal punctuation or
// apostrophes — grading relies on contractions.
function stripTrailingLinePunctuation(line: string): string {
  return line.replace(/[\s,.;:—–-]+$/u, "").trim()
}

function wordCount(line: string): number {
  const normalized = normalizeForStudy(line)
  if (!normalized) return 0
  if (!/\s/u.test(normalized) && containsSpacelessScript(normalized)) {
    return segmentSpacelessRecallTokens(normalized).length
  }
  return normalized.split(/\s+/u).filter(Boolean).length
}

function splitLyricsForStudy(lyrics: string | null): Array<{ lineId: string; lineIndex: number; text: string }> {
  const seen = new Set<string>()
  const units: Array<{ lineId: string; lineIndex: number; text: string }> = []
  String(lyrics ?? "")
    .split(/\r?\n/u)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .filter((line) => !/^\[[^\]]+\]$/u.test(line))
    .forEach((line, index) => {
      if (isPureAdLib(line)) return
      const text = stripTrailingLinePunctuation(stripTrailingAdLibs(line))
      if (wordCount(text) < 2) return
      const normalized = normalizeForStudy(text)
      if (seen.has(normalized)) return
      seen.add(normalized)
      units.push({ lineId: studyLineId(index), lineIndex: index, text })
    })
  return units
}

function optionId(lineIndex: number, optionIndex: number): string {
  return `line_${String(lineIndex + 1).padStart(3, "0")}_opt_${optionIndex + 1}`
}

function orderedTranslationOptions(input: {
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

function mapStudyUnitRow(row: Record<string, unknown>): StudyUnitRow {
  return {
    id: readString(row.id) ?? "",
    line_id: readString(row.line_id) ?? "",
    line_index: Number(row.line_index ?? 0),
    max_attempts: Number(row.max_attempts ?? 2),
    prompt_text: readString(row.prompt_text) ?? "",
    reference_text: readString(row.reference_text) ?? readString(row.prompt_text) ?? "",
    say_it_back_status: (readString(row.say_it_back_status) ?? "ready") as StudyUnitRow["say_it_back_status"],
    source_language: readString(row.source_language),
    unit_version: Number(row.unit_version ?? 1),
  }
}

async function selectStudyUnits(client: ReadClient, postId: string): Promise<StudyUnitRow[]> {
  const result = await client.execute({
    sql: `
      SELECT id, line_id, line_index, source_language, prompt_text, reference_text,
             say_it_back_status, unit_version, max_attempts
      FROM song_study_unit
      WHERE post_id = ?1
      ORDER BY line_index ASC
    `,
    args: [postId],
  })
  return result.rows.map((row) => mapStudyUnitRow(row as Record<string, unknown>))
}

async function upsertStudyUnit(client: Client, post: StudyPost, line: { lineId: string; lineIndex: number; text: string }, now: string): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO song_study_unit (
        id, post_id, line_id, line_index, source_language, prompt_text,
        reference_text, say_it_back_status, unit_version, max_attempts,
        created_at, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6, 'ready', ?7, 2, ?8, ?8)
      ON CONFLICT(post_id, line_id) DO UPDATE SET
        line_index = excluded.line_index,
        source_language = excluded.source_language,
        prompt_text = excluded.prompt_text,
        reference_text = excluded.reference_text,
        say_it_back_status = excluded.say_it_back_status,
        unit_version = excluded.unit_version,
        max_attempts = excluded.max_attempts,
        updated_at = excluded.updated_at
    `,
    args: [
      makeId("stu"),
      post.post_id,
      line.lineId,
      line.lineIndex,
      post.source_language,
      line.text,
      STUDY_UNIT_GENERATION_VERSION,
      now,
    ],
  })
}

// Explicit cascade: D1/SQLite (and the libsql test client) do not enforce
// FOREIGN KEY ... ON DELETE CASCADE unless PRAGMA foreign_keys=ON, so delete the
// unit's localizations before the unit itself. Per-user attempts/review_state are
// keyed by (post_id, line_id) rather than unit_id and are left as an audit trail.
async function deleteStudyUnits(client: Client, unitIds: string[]): Promise<void> {
  if (unitIds.length === 0) return
  const placeholders = unitIds.map(() => "?").join(", ")
  await client.execute({
    sql: `DELETE FROM song_study_unit_localization WHERE unit_id IN (${placeholders})`,
    args: unitIds,
  })
  await client.execute({
    sql: `DELETE FROM song_study_unit WHERE id IN (${placeholders})`,
    args: unitIds,
  })
}

async function ensureStudyUnits(client: Client, post: StudyPost): Promise<StudyUnitRow[]> {
  const existing = await selectStudyUnits(client, post.post_id)
  // Fresh units are returned as-is. A version bump (e.g. changed line heuristics or
  // punctuation canonicalization) makes existing units stale and forces a re-split so
  // their stored text is regenerated — ensureStudyUnits only ran once historically.
  if (existing.length > 0 && existing.every((unit) => unit.unit_version >= STUDY_UNIT_GENERATION_VERSION)) {
    return existing
  }

  const lines = splitLyricsForStudy(post.lyrics)
  const now = nowIso()
  // Upsert keeps the stable primary key + line_id for surviving lines (line_id is
  // index-derived and unaffected by punctuation changes), so their FK localizations
  // and per-user review_state (keyed by line_id) are preserved across the re-split.
  for (const line of lines) {
    await upsertStudyUnit(client, post, line, now)
  }

  // Remove units the current split no longer produces (edited lyrics or heuristic
  // changes) so their localizations don't linger as orphans. Punctuation
  // canonicalization alone never drops a line — dedup already normalizes punctuation
  // away — but a version-gated re-split must still be correct if the set does change.
  if (existing.length > 0) {
    const keep = new Set(lines.map((line) => line.lineId))
    const staleIds = existing.filter((unit) => !keep.has(unit.line_id)).map((unit) => unit.id)
    await deleteStudyUnits(client, staleIds)
  }

  return selectStudyUnits(client, post.post_id)
}

async function createReadyStudyPack(input: {
  client: Client
  env: Env
  post: StudyPost
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
      .filter((unit) => wordCount(unit.prompt_text) >= 3)
      .map((unit) => {
        const previous = units.find((candidate) => candidate.line_index === unit.line_index - 1)
        return {
          lineId: unit.line_id,
          previous: previous?.prompt_text ?? null,
          text: unit.prompt_text,
        }
      })
    const chunks = chunkArray(requestLines, studyGenerationChunkSize(input.env))
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
  for (const unit of units) {
    const generatedLine = generatedLines.get(unit.line_id)
    if (!generatedLine || generatedLine.distractors.length < 3) {
      unavailableLineCount += 1
      const existing = existingLocalizations.get(unit.id)
      if (existing?.status === "ready") {
        continue
      }
      await input.client.execute({
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
    await input.client.execute({
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
    status: "ready",
    study_pack_version: Math.max(STUDY_UNIT_GENERATION_VERSION, STUDY_LOCALIZATION_GENERATION_VERSION),
    target_language: input.targetLanguage,
    unavailable_reason: null,
  }
}

async function hasCompleteReadyStudyLocalizations(input: {
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
  for (const unit of input.units) {
    await input.client.execute({
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
    })
  }
}

async function enqueueStudyGenerationIfNeeded(input: {
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
  // Never enqueue same-language translation generation: it would burn LLM tokens
  // producing degenerate "translate X into the same language" paraphrase MCQs.
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

function basePayload(input: {
  access: StudyAccess
  post: StudyPost
  targetLanguage: string
}): SongStudyPayload {
  return {
    access: input.access,
    artwork_src: input.post.song_cover_art_ref,
    community_id: publicCommunityId(input.post.community_id),
    exercise_count: 0,
    exercises: [],
    object: "song_study_payload",
    post_id: publicPostId(input.post.post_id),
    source_language: input.post.source_language,
    target_language: input.targetLanguage,
    title: publicTitle(input.post),
  }
}

export async function getPostStudyPayload(input: {
  actor: ActorContext | AdminActorContext
  communityId: string
  communityRepository: CommunityDatabaseBindingRepository
  env: Env
  postId: string
  targetLanguage?: string | null
}): Promise<SongStudyPayload> {
  const targetLanguage = normalizeStudyTargetLanguage(input.targetLanguage)
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const post = await getStudyPostById(db.client, input.postId)
    if (!post || post.community_id !== input.communityId) throw notFoundError("Post not found")
    if (!await canReadPostForStudy({ actor: input.actor, client: db.client, post })) {
      throw notFoundError("Post not found")
    }
    if (!await isCommunityStudyEnabled({ executor: db.client, communityId: input.communityId })) {
      return basePayload({ access: "unavailable", post, targetLanguage })
    }
    if (post.post_type !== "song") {
      return {
        ...basePayload({ access: "unavailable", post, targetLanguage }),
        unavailable_reason: "not_song",
      }
    }
    if (!await canStudyPost({ actor: input.actor, client: db.client, communityId: input.communityId, post })) {
      return {
        ...basePayload({ access: "locked", post, targetLanguage }),
        locked_reason: "purchase_required",
      }
    }

    const units = await ensureStudyUnits(db.client, post)
    if (units.length === 0) {
      return {
        ...basePayload({ access: "unavailable", post, targetLanguage }),
        unavailable_reason: "no_lyrics",
      }
    }
    // Suppress translation_choice entirely when the learner's target language matches
    // the song's source language — the read path must exclude already-generated rows,
    // not just stop future enqueues (existing en localizations would otherwise serve).
    const includeTranslation = !isSameLanguageStudyPair(post.source_language, targetLanguage)
    await enqueueStudyGenerationIfNeeded({
      client: db.client,
      communityId: input.communityId,
      env: input.env,
      postId: input.postId,
      sourceLanguage: post.source_language,
      targetLanguage,
      units,
    })

    const pack = await getLatestPack({ client: db.client, postId: input.postId, targetLanguage })
    if (includeTranslation && pack?.status === "unavailable") {
      return {
        ...basePayload({ access: "unavailable", post, targetLanguage: pack.target_language }),
        source_language: pack.source_language ?? post.source_language,
        unavailable_reason: pack.unavailable_reason ?? "generation_failed",
      }
    }

    const includeSayItBack = (await getCommunityElevenLabsStudyCapability({
      client: db.client,
      env: input.env,
      communityId: input.communityId,
    })).active
    const now = nowIso()
    const reServeDueReviews = dueReviewServingEnabled(input.env)
    const canonicalExerciseRows = await listExercises({
      client: db.client,
      dueReviewServing: true,
      includeSayItBack,
      includeTranslation,
      now,
      postId: input.postId,
      targetLanguage,
    })
    const exerciseRows = await listExercises({
      client: db.client,
      dueReviewServing: reServeDueReviews,
      includeSayItBack,
      includeTranslation,
      now,
      postId: input.postId,
      targetLanguage,
      userId: input.actor.userId,
    })
    const exercises = exerciseRows.map((row) => toExercise(row, input.actor.userId))
    const nextDueAt = exercises.length === 0 && canonicalExerciseRows.length > 0
      ? await getNextDueAt({
        client: db.client,
        includeSayItBack,
        includeTranslation,
        now,
        postId: input.postId,
        targetLanguage,
        userId: input.actor.userId,
      })
      : null
    const nextDueAtSeconds = toUnixSeconds(nextDueAt)
    const session: SongStudySessionSummary = {
      due_count: exerciseRows.length,
      served_count: exercises.length,
      total_units: canonicalExerciseRows.length,
      ...(nextDueAtSeconds ? { next_due_at: nextDueAtSeconds } : {}),
    }
    if (exercises.length === 0) {
      if (canonicalExerciseRows.length > 0) {
        return {
          ...basePayload({ access: "ready", post, targetLanguage }),
          generated_at: toUnixSeconds(pack?.generated_at ?? null),
          session,
          source_language: pack?.source_language ?? post.source_language,
          study_pack_version: pack?.study_pack_version ?? STUDY_UNIT_GENERATION_VERSION,
        }
      }
      // Only report "processing" (translations still generating) when translations are
      // actually expected. For a same-language pair nothing will ever generate, so an
      // empty pack means say-it-back is the only possible type and its provider is missing.
      if (!includeSayItBack && includeTranslation && canGenerateStudyTranslations(input.env)) {
        return {
          ...basePayload({ access: "processing", post, targetLanguage }),
          source_language: pack?.source_language ?? post.source_language,
        }
      }
      return {
        ...basePayload({ access: "unavailable", post, targetLanguage }),
        source_language: pack?.source_language ?? post.source_language,
        unavailable_reason: includeSayItBack ? "no_lyrics" : "missing_transcription_provider",
      }
    }
    return {
      ...basePayload({ access: "ready", post, targetLanguage }),
      exercise_count: exercises.length,
      exercises,
      generated_at: toUnixSeconds(pack?.generated_at ?? null),
      session,
      source_language: pack?.source_language ?? post.source_language,
      study_pack_version: pack?.study_pack_version ?? STUDY_UNIT_GENERATION_VERSION,
    }
  } finally {
    await db.close()
  }
}

type SongStudyGenerateJobPayload = {
  post_id?: string | null
  target_language?: string | null
}

export async function runSongStudyGenerate(input: CommunityJobHandlerInput): Promise<string | null> {
  const payload = parseJobPayload<SongStudyGenerateJobPayload>(input.job.payload_json)
  const postId = readString(payload?.post_id) ?? input.job.subject_id.split(":")[0] ?? input.job.subject_id
  const targetLanguage = normalizeStudyTargetLanguage(payload?.target_language)
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.job.community_id)
  try {
    const post = await getStudyPostById(db.client, postId)
    if (!post || post.community_id !== input.job.community_id || post.post_type !== "song") {
      return "skipped:missing_song"
    }
    if (!await isCommunityStudyEnabled({ executor: db.client, communityId: input.job.community_id })) {
      return "skipped:study_disabled"
    }
    // A queued job for a same-language pair (e.g. enqueued before this guard existed)
    // must not generate degenerate same-language translation MCQs.
    if (isSameLanguageStudyPair(post.source_language, targetLanguage)) {
      return "skipped:same_language"
    }
    const units = await ensureStudyUnits(db.client, post)
    if (units.length === 0) return "skipped:no_lyrics"
    if (await hasCompleteReadyStudyLocalizations({
      client: db.client,
      postId,
      targetLanguage,
    })) {
      return "ready:already_generated"
    }
    if (!canGenerateStudyTranslations(input.env)) {
      return "skipped:openrouter_unconfigured"
    }
    const pack = await createReadyStudyPack({
      client: db.client,
      env: input.env,
      post,
      targetLanguage,
    })
    return pack?.job_result_ref ?? (pack?.status === "ready" ? `ready:${targetLanguage}` : "skipped:generation_unavailable")
  } finally {
    await db.close()
  }
}

async function getExerciseForAttempt(client: ReadClient, exerciseId: string): Promise<(StudyExerciseRow & {
  post_id: string
  source_language: string | null
  status: StudyPack["status"]
  study_pack_version: number
  target_language: string
}) | null> {
  const sayItBackMatch = /^stu:([^:]+):say_it_back:([^:]+)$/u.exec(exerciseId)
  if (sayItBackMatch) {
    const unitId = sayItBackMatch[1]!
    const row = await executeFirst(client, {
      sql: `
        SELECT id, post_id, line_id, line_index, source_language, prompt_text,
               reference_text, say_it_back_status, unit_version, max_attempts
        FROM song_study_unit
        WHERE id = ?1
        LIMIT 1
      `,
      args: [unitId],
    }) as Record<string, unknown> | null
    if (!row) return null
    const sourceLanguage = readString(row.source_language) ?? "source"
    return {
      correct_option_id: null,
      exercise_type: "say_it_back",
      id: exerciseId,
      line_id: readString(row.line_id) ?? "",
      line_index: Number(row.line_index ?? 0),
      max_attempts: Number(row.max_attempts ?? 2),
      options_json: null,
      post_id: readString(row.post_id) ?? "",
      prompt_text: readString(row.prompt_text) ?? "",
      question: null,
      reference_text: readString(row.reference_text),
      review_language: sourceLanguage,
      source_language: sourceLanguage,
      status: (readString(row.say_it_back_status) === "ready" ? "ready" : "unavailable"),
      study_pack_version: Number(row.unit_version ?? 1),
      target_language: sourceLanguage,
      translation_text: null,
    }
  }

  const translationMatch = /^stu:([^:]+):translation_choice:(.+)$/u.exec(exerciseId)
  if (translationMatch) {
    const unitId = translationMatch[1]!
    const targetLanguage = translationMatch[2]!
    const row = await executeFirst(client, {
      sql: `
        SELECT u.id, u.post_id, u.line_id, u.line_index, u.source_language,
               u.prompt_text, l.question, l.translation_text, l.options_json,
               l.correct_option_id, l.max_attempts, l.status, l.localization_version,
               l.target_language
        FROM song_study_unit u
        JOIN song_study_unit_localization l ON l.unit_id = u.id
        WHERE u.id = ?1
          AND l.target_language = ?2
        LIMIT 1
      `,
      args: [unitId, targetLanguage],
    }) as Record<string, unknown> | null
    if (!row) return null
    return {
      correct_option_id: readString(row.correct_option_id),
      exercise_type: "translation_choice",
      id: exerciseId,
      line_id: readString(row.line_id) ?? "",
      line_index: Number(row.line_index ?? 0),
      max_attempts: Number(row.max_attempts ?? 1),
      options_json: readString(row.options_json),
      post_id: readString(row.post_id) ?? "",
      prompt_text: readString(row.prompt_text) ?? "",
      question: readString(row.question),
      reference_text: null,
      review_language: readString(row.target_language) ?? targetLanguage,
      source_language: readString(row.source_language),
      status: (readString(row.status) ?? "processing") as StudyPack["status"],
      study_pack_version: Number(row.localization_version ?? 1),
      target_language: readString(row.target_language) ?? targetLanguage,
      translation_text: readString(row.translation_text),
    }
  }

  return null
}

function normalizeForStudy(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s']/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
}

const IGNORED_RECALL_TOKENS = new Set(["a", "an", "the"])

function expandEnglishContractions(value: string): string {
  return value
    .replace(/\b(can)'t\b/giu, "$1 not")
    .replace(/\b(won)'t\b/giu, "will not")
    .replace(/\b(i)'m\b/giu, "$1 am")
    .replace(/\b([a-z]+)'re\b/giu, "$1 are")
    .replace(/\b([a-z]+)'ve\b/giu, "$1 have")
    .replace(/\b([a-z]+)'ll\b/giu, "$1 will")
    .replace(/\b([a-z]+)'d\b/giu, "$1 would")
    .replace(/\b([a-z]+)'s\b/giu, "$1 is")
}

function normalizeRecallToken(token: string): string {
  const compact = token.replace(/'/gu, "")
  if (compact.length > 4 && compact.endsWith("ies")) return `${compact.slice(0, -3)}y`
  if (compact.length > 4 && /(ches|shes|xes|zes|ses)$/u.test(compact)) return compact.slice(0, -2)
  if (compact.length > 3 && compact.endsWith("s")) return compact.slice(0, -1)
  return compact
}

function recallTokens(value: string): string[] {
  return normalizeForStudy(expandEnglishContractions(value))
    .split(" ")
    .map(normalizeRecallToken)
    .filter((token) => token && !IGNORED_RECALL_TOKENS.has(token))
}

function languageAgnosticRecallTokens(value: string): string[] {
  const normalized = normalizeForStudy(value)
  if (!normalized) return []
  if (/\s/u.test(normalized) || !containsSpacelessScript(normalized)) {
    return normalized.split(" ").filter(Boolean)
  }
  return segmentSpacelessRecallTokens(normalized)
}

function containsSpacelessScript(value: string): boolean {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u.test(value)
}

function segmentSpacelessRecallTokens(value: string): string[] {
  const segmenterConstructor = (Intl as typeof Intl & {
    Segmenter?: new (locale?: string, options?: { granularity?: "grapheme" | "word" | "sentence" }) => {
      segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }>
    }
  }).Segmenter
  if (segmenterConstructor) {
    const words = Array.from(new segmenterConstructor(undefined, { granularity: "word" }).segment(value))
      .filter((segment) => segment.isWordLike !== false)
      .map((segment) => segment.segment.trim())
      .filter(Boolean)
    if (words.length > 1) return words
  }
  return Array.from(value).filter((token) => token.trim())
}

function recallTokensForSourceLanguage(value: string, sourceLanguage: string | null | undefined): string[] {
  return String(sourceLanguage ?? "").toLowerCase().startsWith("en")
    ? recallTokens(value)
    : languageAgnosticRecallTokens(value)
}

function tokenDiff(reference: string, transcript: string, sourceLanguage: string | null | undefined): { matched: string[]; missing: string[]; extra: string[] } {
  const referenceTokens = recallTokensForSourceLanguage(reference, sourceLanguage)
  const transcriptTokens = recallTokensForSourceLanguage(transcript, sourceLanguage)
  const remaining = [...transcriptTokens]
  const matched: string[] = []
  const missing: string[] = []
  for (const token of referenceTokens) {
    const index = remaining.indexOf(token)
    if (index >= 0) {
      matched.push(token)
      remaining.splice(index, 1)
    } else {
      missing.push(token)
    }
  }
  return { matched, missing, extra: remaining }
}

function tokenEditDistance(left: string[], right: string[]): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0]
    previous[0] = leftIndex
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const old = previous[rightIndex]
      const cost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + cost,
      )
      diagonal = old
    }
  }
  return previous[right.length] ?? 0
}

function gradeSayItBack(input: {
  attemptNumber: number
  reference: string
  sourceLanguage: string | null | undefined
  transcript: string
}): { correct: boolean; feedback: { matched: string[]; missing: string[]; extra: string[] }; rating: FsrsRating } {
  const referenceTokens = recallTokensForSourceLanguage(input.reference, input.sourceLanguage)
  const transcriptTokens = recallTokensForSourceLanguage(input.transcript, input.sourceLanguage)
  const distance = tokenEditDistance(referenceTokens, transcriptTokens)
  const maxLength = Math.max(referenceTokens.length, transcriptTokens.length, 1)
  const nearMiss = distance > 0 && distance <= Math.max(1, Math.floor(maxLength * 0.25))
  const correct = distance === 0
  return {
    correct,
    feedback: tokenDiff(input.reference, input.transcript, input.sourceLanguage),
    rating: correct ? fsrsRatingFor("correct", input.attemptNumber) : nearMiss ? "hard" : "again",
  }
}

function fsrsRatingFor(outcome: AttemptOutcome, attemptNumber: number): FsrsRating {
  if (outcome === "revealed") return "again"
  if (outcome === "correct" && attemptNumber <= 1) return "good"
  if (outcome === "correct") return "hard"
  return "again"
}

function resultFromAttempt(row: StudyAttemptRow, exercise: { correct_option_id: string | null; exercise_type: ExerciseType; max_attempts: number }): SongStudyAttemptResult {
  const feedback = row.feedback_json ? JSON.parse(row.feedback_json) as SongStudyAttemptResult["feedback"] : undefined
  return {
    attempts_remaining: Math.max(0, exercise.max_attempts - row.attempt_number),
    ...(exercise.exercise_type === "translation_choice"
      && (row.outcome === "correct" || row.outcome === "revealed")
      && exercise.correct_option_id
      ? { correct_option_id: exercise.correct_option_id }
      : {}),
    exercise_id: row.exercise_id,
    ...(feedback ? { feedback } : {}),
    ...(row.fsrs_rating ? { next_review_hint: row.fsrs_rating } : {}),
    object: "song_study_attempt_result",
    outcome: row.outcome,
  }
}

async function getAttemptByIdempotencyKey(
  client: ReadClient,
  userId: string,
  idempotencyKey: string,
): Promise<StudyAttemptRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT exercise_id, exercise_type, attempt_number,
             selected_option_id, transcript, outcome, feedback_json, fsrs_rating
      FROM song_study_attempt
      WHERE user_id = ?1
        AND idempotency_key = ?2
      LIMIT 1
    `,
    args: [userId, idempotencyKey],
  }) as Record<string, unknown> | null
  return row
    ? {
        attempt_number: Number(row.attempt_number ?? 1),
        exercise_id: readString(row.exercise_id) ?? "",
        feedback_json: readString(row.feedback_json),
        fsrs_rating: readString(row.fsrs_rating) as FsrsRating | null,
        outcome: (readString(row.outcome) ?? "incorrect") as AttemptOutcome,
        selected_option_id: readString(row.selected_option_id),
        transcript: readString(row.transcript),
        type: (readString(row.exercise_type) ?? "say_it_back") as ExerciseType,
      }
    : null
}

function assertEquivalentIdempotentRetry(input: {
  attemptNumber: number
  body: SongStudyAttemptRequest
  existing: StudyAttemptRow
  exerciseId: string
  type: ExerciseType
}): void {
  const selectedOptionId = readString(input.body.selected_option_id)
  const transcript = readString(input.body.transcript)
  const same = input.existing.exercise_id === input.exerciseId
    && input.existing.type === input.type
    && input.existing.attempt_number === input.attemptNumber
    && input.existing.selected_option_id === selectedOptionId
    && input.existing.transcript === transcript
  if (!same) {
    throw conflictError("idempotency_key was reused with a different study attempt payload")
  }
}

async function getReviewState(input: {
  client: ReadClient
  exercise: Awaited<ReturnType<typeof getExerciseForAttempt>> & {}
  userId: string
}): Promise<StudyReviewStateRow | null> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT state, stability, difficulty, due_at, reps, lapses
      FROM song_study_review_state
      WHERE user_id = ?1
        AND post_id = ?2
        AND line_id = ?3
        AND exercise_type = ?4
        AND target_language = ?5
      LIMIT 1
    `,
    args: [
      input.userId,
      input.exercise.post_id,
      input.exercise.line_id,
      input.exercise.exercise_type,
      input.exercise.review_language,
    ],
  }) as Record<string, unknown> | null
  return row
    ? {
        difficulty: Number(row.difficulty ?? 5),
        due_at: readString(row.due_at) ?? "",
        lapses: Number(row.lapses ?? 0),
        reps: Number(row.reps ?? 0),
        stability: Number(row.stability ?? 1),
        state: (readString(row.state) ?? "new") as StudyReviewStateRow["state"],
      }
    : null
}

function addReviewInterval(now: string, intervalMs: number): string {
  const nowMs = Date.parse(now)
  const baseMs = Number.isFinite(nowMs) ? nowMs : Date.now()
  return new Date(baseMs + intervalMs).toISOString()
}

function clampReviewNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Number(value.toFixed(3))))
}

function buildReviewSchedule(input: {
  existing: StudyReviewStateRow | null
  now: string
  rating: FsrsRating
}): StudyReviewSchedule {
  const priorReps = input.existing?.reps ?? 0
  const priorStability = Math.max(0.25, input.existing?.stability ?? 1)
  const priorDifficulty = Math.max(1, Math.min(10, input.existing?.difficulty ?? 5))
  const hourMs = 60 * 60 * 1000
  const dayMs = 24 * hourMs

  if (input.rating === "again") {
    return {
      difficulty: clampReviewNumber(priorDifficulty + 1.2, 1, 10),
      dueAt: addReviewInterval(input.now, 10 * 60 * 1000),
      lapseIncrement: 1,
      stability: clampReviewNumber(Math.max(0.25, priorStability * 0.5), 0.25, 365),
      state: priorReps > 0 ? "relearning" : "learning",
    }
  }

  if (input.rating === "hard") {
    const stability = clampReviewNumber(Math.max(1, priorStability * (priorReps > 0 ? 1.2 : 1)), 0.25, 365)
    return {
      difficulty: clampReviewNumber(priorDifficulty + 0.35, 1, 10),
      dueAt: addReviewInterval(input.now, Math.max(12 * hourMs, stability * dayMs)),
      lapseIncrement: 0,
      stability,
      state: "review",
    }
  }

  if (input.rating === "easy") {
    const stability = clampReviewNumber(priorReps > 0 ? priorStability * 3.5 : 4, 0.25, 365)
    return {
      difficulty: clampReviewNumber(priorDifficulty - 0.8, 1, 10),
      dueAt: addReviewInterval(input.now, stability * dayMs),
      lapseIncrement: 0,
      stability,
      state: "review",
    }
  }

  const stability = clampReviewNumber(priorReps > 0 ? priorStability * 2.5 : 2, 0.25, 365)
  return {
    difficulty: clampReviewNumber(priorDifficulty - 0.25, 1, 10),
    dueAt: addReviewInterval(input.now, stability * dayMs),
    lapseIncrement: 0,
    stability,
    state: "review",
  }
}

async function upsertReviewState(input: {
  client: ReadClient
  existing: StudyReviewStateRow | null
  exercise: Awaited<ReturnType<typeof getExerciseForAttempt>> & {}
  now: string
  rating: FsrsRating
  userId: string
}): Promise<FsrsRating> {
  const schedule = buildReviewSchedule({
    existing: input.existing,
    now: input.now,
    rating: input.rating,
  })
  await input.client.execute({
    sql: `
      INSERT INTO song_study_review_state (
        user_id, post_id, line_id, exercise_type, target_language,
        state, stability, difficulty, due_at, last_reviewed_at,
        reps, lapses, fsrs_params_version, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, ?11, ?12, ?13)
      ON CONFLICT(user_id, post_id, line_id, exercise_type, target_language)
      DO UPDATE SET
        state = excluded.state,
        stability = excluded.stability,
        difficulty = excluded.difficulty,
        due_at = excluded.due_at,
        last_reviewed_at = excluded.last_reviewed_at,
        reps = song_study_review_state.reps + 1,
        lapses = song_study_review_state.lapses + excluded.lapses,
        fsrs_params_version = excluded.fsrs_params_version,
        updated_at = excluded.updated_at
    `,
    args: [
      input.userId,
      input.exercise.post_id,
      input.exercise.line_id,
      input.exercise.exercise_type,
      input.exercise.review_language,
      schedule.state,
      schedule.stability,
      schedule.difficulty,
      schedule.dueAt,
      input.now,
      schedule.lapseIncrement,
      FSRS_PARAMS_VERSION,
      input.now,
    ],
  })
  return input.rating
}

type StudyEngagementProgress = {
  qualifiedToday: boolean
  studyAttemptCount: number
  studyCorrectCount: number
  studyTargetCount: number
}

export async function upsertStudyEngagementDay(input: {
  client: ReadClient
  communityId: string
  isCorrect: boolean
  now: string
  postId: string
  studyTargetCount: number
  userId: string
}): Promise<void> {
  const today = input.now.slice(0, 10)
  const isCorrect = input.isCorrect ? 1 : 0
  await input.client.execute({
    sql: `
      INSERT INTO song_engagement_days (
        user_id, post_id, community_id, activity_date,
        study_attempt_count, study_correct_count, study_target_count,
        karaoke_pass_count, qualified, created_at, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, 0, CASE WHEN ?5 >= ?6 THEN 1 ELSE 0 END, ?7, ?7)
      ON CONFLICT(user_id, post_id, activity_date) DO UPDATE SET
        study_attempt_count = song_engagement_days.study_attempt_count + 1,
        study_correct_count = song_engagement_days.study_correct_count + ?5,
        qualified = CASE
          WHEN song_engagement_days.study_correct_count + ?5 >= song_engagement_days.study_target_count THEN 1
          WHEN song_engagement_days.karaoke_pass_count > 0 THEN 1
          ELSE song_engagement_days.qualified
        END,
        updated_at = ?7
    `,
    args: [
      input.userId,
      input.postId,
      input.communityId,
      today,
      isCorrect,
      input.studyTargetCount,
      input.now,
    ],
  })
}

function previousDateString(date: string): string {
  const ms = Date.parse(`${date}T00:00:00.000Z`)
  if (!Number.isFinite(ms)) return date
  return new Date(ms - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

async function projectStudyStreakCount(input: {
  client: ReadClient
  engagement: StudyEngagementProgress
  now: string
  postId: string
  userId: string
}): Promise<number> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT current_streak, last_qualified_date
      FROM song_streaks
      WHERE user_id = ?1
        AND post_id = ?2
    `,
    args: [input.userId, input.postId],
  }) as Record<string, unknown> | null
  const current = Number(row?.current_streak ?? 0)
  if (!input.engagement.qualifiedToday) return current
  const today = input.now.slice(0, 10)
  const lastQualifiedDate = readString(row?.last_qualified_date)
  if (!lastQualifiedDate) return 1
  if (lastQualifiedDate >= today) return current
  if (lastQualifiedDate === previousDateString(today)) return current + 1
  return 1
}

async function getStudyAttemptProgressSnapshot(input: {
  client: ReadClient
  includeSayItBack: boolean
  includeTranslation: boolean
  now: string
  postId: string
  targetLanguage: string
  userId: string
}): Promise<SongStudyAttemptProgress | undefined> {
  const today = input.now.slice(0, 10)
  const row = await executeFirst(input.client, {
    sql: `
      SELECT study_attempt_count, study_correct_count, study_target_count, qualified
      FROM song_engagement_days
      WHERE user_id = ?1
        AND post_id = ?2
        AND activity_date = ?3
    `,
    args: [input.userId, input.postId, today],
  }) as Record<string, unknown> | null
  if (!row) return undefined
  const engagement: StudyEngagementProgress = {
    qualifiedToday: Number(row.qualified ?? 0) === 1,
    studyAttemptCount: Number(row.study_attempt_count ?? 0),
    studyCorrectCount: Number(row.study_correct_count ?? 0),
    studyTargetCount: Number(row.study_target_count ?? 0),
  }
  const [currentStreak, nextDueAt] = await Promise.all([
    projectStudyStreakCount({
      client: input.client,
      engagement,
      now: input.now,
      postId: input.postId,
      userId: input.userId,
    }),
    getNextDueAt({
      client: input.client,
      includeSayItBack: input.includeSayItBack,
      includeTranslation: input.includeTranslation,
      now: input.now,
      postId: input.postId,
      targetLanguage: input.targetLanguage,
      userId: input.userId,
    }),
  ])
  const nextDueAtSeconds = toUnixSeconds(nextDueAt)
  return {
    current_streak: currentStreak,
    ...(nextDueAtSeconds ? { next_due_at: nextDueAtSeconds } : {}),
    qualified_today: engagement.qualifiedToday,
    study_attempt_count: engagement.studyAttemptCount,
    study_correct_count: engagement.studyCorrectCount,
    study_target_count: engagement.studyTargetCount,
  }
}

export async function materializeStudyStreak(input: {
  client: ReadClient
  now: string
  postId: string
  userId: string
}): Promise<void> {
  const today = input.now.slice(0, 10)
  await input.client.execute({
    sql: `
      INSERT INTO song_streaks (
        user_id, post_id, community_id, current_streak, best_streak,
        last_qualified_date, streak_started_date, total_qualified_days,
        created_at, updated_at
      )
      SELECT d.user_id, d.post_id, d.community_id, 1, 1,
             d.activity_date, d.activity_date, 1, ?4, ?4
      FROM song_engagement_days d
      WHERE d.user_id = ?1
        AND d.post_id = ?2
        AND d.activity_date = ?3
        AND d.qualified = 1
      ON CONFLICT(user_id, post_id) DO UPDATE SET
        current_streak = CASE
          WHEN excluded.last_qualified_date <= song_streaks.last_qualified_date
            THEN song_streaks.current_streak
          WHEN song_streaks.last_qualified_date = date(excluded.last_qualified_date, '-1 day')
            THEN song_streaks.current_streak + 1
          ELSE 1
        END,
        best_streak = MAX(song_streaks.best_streak, CASE
          WHEN excluded.last_qualified_date <= song_streaks.last_qualified_date THEN song_streaks.current_streak
          WHEN song_streaks.last_qualified_date = date(excluded.last_qualified_date, '-1 day') THEN song_streaks.current_streak + 1
          ELSE 1
        END),
        streak_started_date = CASE
          WHEN excluded.last_qualified_date <= song_streaks.last_qualified_date THEN song_streaks.streak_started_date
          WHEN song_streaks.last_qualified_date = date(excluded.last_qualified_date, '-1 day') THEN song_streaks.streak_started_date
          ELSE excluded.last_qualified_date
        END,
        total_qualified_days = song_streaks.total_qualified_days + CASE
          WHEN excluded.last_qualified_date <= song_streaks.last_qualified_date THEN 0
          ELSE 1
        END,
        last_qualified_date = MAX(song_streaks.last_qualified_date, excluded.last_qualified_date),
        updated_at = ?4
    `,
    args: [input.userId, input.postId, today, input.now],
  })
}

export async function upsertStudyStreakProgress(input: {
  client: ReadClient
  communityId: string
  isCorrect: boolean
  now: string
  postId: string
  studyTargetCount: number
  userId: string
}): Promise<void> {
  await upsertStudyEngagementDay(input)
  await materializeStudyStreak(input)
}

async function resolveStudyStreakTargetCount(input: {
  client: ReadClient
  communityId: string
  countDueReviews: boolean
  env: Env
  now: string
  postId: string
  sourceLanguage: string | null
  targetLanguage: string
  userId: string
}): Promise<{
  count: number
  credentialSource?: CommunityElevenLabsStudyCapability["source"]
  credentialProbeMs?: number
  dueReviewCountMs?: number
  includeSayItBack: boolean
  includeTranslation: boolean
  totalMs: number
}> {
  const startedAt = performance.now()
  const credentialProbeStartedAt = performance.now()
  const capability = await getCommunityElevenLabsStudyCapability({
    client: input.client,
    env: input.env,
    communityId: input.communityId,
  })
  const credentialProbeMs = elapsedMs(credentialProbeStartedAt)
  const includeSayItBack = capability.active
  const includeTranslation = !isSameLanguageStudyPair(input.sourceLanguage, input.targetLanguage)
  if (!input.countDueReviews) {
    const exerciseCountStartedAt = performance.now()
    const exerciseCount = (await listExercises({
      client: input.client,
      dueReviewServing: false,
      includeSayItBack,
      includeTranslation,
      now: input.now,
      postId: input.postId,
      targetLanguage: input.targetLanguage,
      userId: null,
    })).length
    const dueReviewCountMs = elapsedMs(exerciseCountStartedAt)
    return {
      // Freeze the day's Study target on first write. If async generation has only
      // produced a smaller ready set, that smaller pack is the bar for this pilot day.
      count: studyTargetCountFromServeableExerciseCount(exerciseCount),
      credentialSource: capability.source,
      credentialProbeMs,
      dueReviewCountMs,
      includeSayItBack,
      includeTranslation,
      totalMs: elapsedMs(startedAt),
    }
  }
  const dueReviewCountStartedAt = performance.now()
  const dueBefore = await countDueReviewExercises({
    client: input.client,
    includeSayItBack,
    includeTranslation,
    now: input.now,
    postId: input.postId,
    targetLanguage: input.targetLanguage,
    userId: input.userId,
  })
  const dueReviewCountMs = elapsedMs(dueReviewCountStartedAt)
  return {
    count: studyTargetCountFromDueBefore(dueBefore),
    credentialSource: capability.source,
    credentialProbeMs,
    dueReviewCountMs,
    includeSayItBack,
    includeTranslation,
    totalMs: elapsedMs(startedAt),
  }
}

async function recordStudyStreakMaterialization(input: {
  communityId: string
  communityRepository: CommunityDatabaseBindingRepository
  env: Env
  now: string
  postId: string
  userId: string
}): Promise<void> {
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    await withTransaction(db.client, "write", async (tx) => {
      await materializeStudyStreak({
        client: tx,
        now: input.now,
        postId: input.postId,
        userId: input.userId,
      })
    })
  } finally {
    await db.close()
  }
}

export async function submitPostStudyAttempt(input: {
  actor: ActorContext | AdminActorContext
  body: SongStudyAttemptRequest
  communityId: string
  communityRepository: CommunityDatabaseBindingRepository
  env: Env
  postId: string
  testHooks?: {
    beforeDeferredStreakMaterialization?: () => Promise<void>
  }
  waitUntil?: (promise: Promise<void>) => void
}): Promise<SongStudyAttemptResult> {
  const idempotencyKey = readRequiredString(input.body.idempotency_key, "idempotency_key")
  const exerciseId = readRequiredString(input.body.exercise_id, "exercise_id")
  const type = readRequiredString(input.body.type, "type") as ExerciseType
  if (type !== "say_it_back" && type !== "translation_choice") {
    throw badRequestError("type must be say_it_back or translation_choice")
  }
  const attemptNumber = readAttemptNumber(input.body.attempt_number)

  const timingEnabled = studyAttemptTimingLogsEnabled(input.env)
  const timingStartedAt = performance.now()
  let openClientMs: number | undefined
  let parallelReadBatchMs: number | undefined
  let accessReadBatchMs: number | undefined
  let writeTxMs: number | undefined
  let streakInlineMs: number | undefined
  let closeClientMs: number | undefined
  let credentialProbeMs: number | undefined
  let credentialSource: CommunityElevenLabsStudyCapability["source"] | undefined
  let dueReviewCountMs: number | undefined
  let streakTargetCountMs: number | undefined
  let timingOutcome = "error"
  let timingExerciseType: ExerciseType | undefined
  let timingStreakDeferred = false
  let timingStreakWritesEnabled = false
  let resultForTiming: SongStudyAttemptResult | undefined
  let studyProgress: SongStudyAttemptProgress | undefined
  const openClientStartedAt = performance.now()
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  openClientMs = elapsedMs(openClientStartedAt)
  try {
    const communityStudyEnabled = await isCommunityStudyEnabled({ executor: db.client, communityId: input.communityId })
    if (!communityStudyEnabled) {
      throw new HttpError(403, "forbidden", "Study is disabled for this community")
    }

    const existing = await getAttemptByIdempotencyKey(db.client, input.actor.userId, idempotencyKey)
    const existingExercise = existing ? await getExerciseForAttempt(db.client, existing.exercise_id) : null
    if (existing && existingExercise) {
      assertEquivalentIdempotentRetry({
        attemptNumber,
        body: input.body,
        existing,
        exerciseId,
        type,
      })
      timingOutcome = "idempotent_retry"
      timingExerciseType = existingExercise.exercise_type
      resultForTiming = resultFromAttempt(existing, existingExercise)
      return resultForTiming
    }

    const exercise = await getExerciseForAttempt(db.client, exerciseId)
    if (!exercise || exercise.post_id !== input.postId || exercise.status !== "ready") {
      throw notFoundError("Study exercise not found")
    }
    if (exercise.exercise_type !== type) {
      throw badRequestError("type does not match exercise")
    }
    timingExerciseType = exercise.exercise_type
    // Refuse to grade same-language translation_choice attempts (e.g. from a client that
    // still holds an exercise id generated before this exercise type was suppressed).
    // Mirror the read-path exclusion so it reads as "not offered", not a server error.
    if (exercise.exercise_type === "translation_choice"
      && isSameLanguageStudyPair(exercise.source_language, exercise.target_language)) {
      throw notFoundError("Study exercise not found")
    }
    const now = nowIso()
    const parallelReadBatchStartedAt = performance.now()
    const [existingReviewState, post] = await Promise.all([
      getReviewState({
        client: db.client,
        exercise,
        userId: input.actor.userId,
      }),
      getStudyPostById(db.client, input.postId),
    ])
    parallelReadBatchMs = elapsedMs(parallelReadBatchStartedAt)
    if (attemptNumber > exercise.max_attempts) {
      throw badRequestError("attempt_number exceeds max_attempts")
    }
    if (existingReviewState && attemptNumber <= 1 && !(
      dueReviewServingEnabled(input.env)
      && isDueReview({ dueAt: existingReviewState.due_at, now })
    )) {
      throw notFoundError("Study exercise not found")
    }

    if (!post || post.community_id !== input.communityId) throw notFoundError("Post not found")
    const accessReadBatchStartedAt = performance.now()
    const [canReadPost, canStudy] = await Promise.all([
      canReadPostForStudy({ actor: input.actor, client: db.client, post }),
      canStudyPost({ actor: input.actor, client: db.client, communityId: input.communityId, post }),
    ])
    accessReadBatchMs = elapsedMs(accessReadBatchStartedAt)
    if (!canReadPost) {
      throw notFoundError("Post not found")
    }
    if (!canStudy) {
      throw new HttpError(403, "forbidden", "Caller is not entitled to study this post")
    }
    const streakWritesEnabled = studyStreakWritesEnabled(input.env)
    timingStreakWritesEnabled = streakWritesEnabled
    const streakTargetLanguage = readString(input.body.target_language)
      ? normalizeStudyTargetLanguage(input.body.target_language)
      : exercise.target_language

    let correct = false
    let selectedOptionId: string | null = null
    let transcript: string | null = null
    let feedback: SongStudyAttemptResult["feedback"] | undefined
    let rating: FsrsRating | null = null
    if (type === "translation_choice") {
      selectedOptionId = readRequiredString(input.body.selected_option_id, "selected_option_id")
      if (readString(input.body.transcript)) throw badRequestError("transcript is only valid for say_it_back")
      correct = Boolean(exercise.correct_option_id && selectedOptionId === exercise.correct_option_id)
    } else {
      transcript = readRequiredString(input.body.transcript, "transcript")
      if (readString(input.body.selected_option_id)) throw badRequestError("selected_option_id is only valid for translation_choice")
      const reference = exercise.reference_text || exercise.prompt_text
      const grade = gradeSayItBack({
        attemptNumber,
        reference,
        sourceLanguage: exercise.source_language,
        transcript,
      })
      correct = grade.correct
      feedback = grade.feedback
      rating = grade.rating
    }
    const outcome: AttemptOutcome = correct
      ? "correct"
      : attemptNumber >= exercise.max_attempts ? "revealed" : "incorrect"
    rating ??= fsrsRatingFor(outcome, attemptNumber)
    const attemptsRemaining = Math.max(0, exercise.max_attempts - attemptNumber)
    const isDueReviewAttempt = Boolean(existingReviewState && isDueReview({ dueAt: existingReviewState.due_at, now }))
    const studyStreakTarget = streakWritesEnabled
      ? await resolveStudyStreakTargetCount({
        client: db.client,
        communityId: input.communityId,
        countDueReviews: isDueReviewAttempt,
        env: input.env,
        now,
        postId: input.postId,
        sourceLanguage: post.source_language,
        targetLanguage: streakTargetLanguage,
        userId: input.actor.userId,
      })
      : null
    credentialSource = studyStreakTarget?.credentialSource
    credentialProbeMs = studyStreakTarget?.credentialProbeMs
    dueReviewCountMs = studyStreakTarget?.dueReviewCountMs
    streakTargetCountMs = studyStreakTarget?.totalMs
    const writeTxStartedAt = performance.now()
    const fsrsRating = await withTransaction(db.client, "write", async (tx) => {
      const reviewRating = await upsertReviewState({
        client: tx,
        existing: existingReviewState,
        exercise,
        now,
        rating,
        userId: input.actor.userId,
      })
      await tx.execute({
        sql: `
          INSERT INTO song_study_attempt (
            id, user_id, post_id, exercise_id, line_id, exercise_type,
            target_language, study_pack_version, attempt_number, idempotency_key,
            selected_option_id, transcript, outcome, feedback_json, fsrs_rating, created_at
          )
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
        `,
        args: [
          makeId("sta"),
          input.actor.userId,
          input.postId,
          exercise.id,
          exercise.line_id,
          exercise.exercise_type,
          exercise.review_language,
          exercise.study_pack_version,
          attemptNumber,
          idempotencyKey,
          selectedOptionId,
          transcript,
          outcome,
          feedback ? JSON.stringify(feedback) : null,
          reviewRating,
          now,
        ],
      })
      if (streakWritesEnabled && studyStreakTarget != null) {
        await upsertStudyEngagementDay({
          client: tx,
          communityId: input.communityId,
          isCorrect: outcome === "correct",
          now,
          postId: input.postId,
          studyTargetCount: studyStreakTarget.count,
          userId: input.actor.userId,
        })
      }
      return reviewRating
    })
    writeTxMs = elapsedMs(writeTxStartedAt)
    if (streakWritesEnabled && studyStreakTarget != null) {
      studyProgress = await getStudyAttemptProgressSnapshot({
        client: db.client,
        includeSayItBack: studyStreakTarget.includeSayItBack,
        includeTranslation: studyStreakTarget.includeTranslation,
        now,
        postId: input.postId,
        targetLanguage: streakTargetLanguage,
        userId: input.actor.userId,
      })
    }
    if (streakWritesEnabled) {
      const recordStreak = async () => {
        await input.testHooks?.beforeDeferredStreakMaterialization?.()
        await recordStudyStreakMaterialization({
          communityId: input.communityId,
          communityRepository: input.communityRepository,
          env: input.env,
          now,
          postId: input.postId,
          userId: input.actor.userId,
        })
      }
      if (input.waitUntil) {
        timingStreakDeferred = true
        input.waitUntil(recordStreak().catch((error) => {
          console.error("[song-study] streak progress update failed", {
            error,
            post_id: input.postId,
            user_id: input.actor.userId,
          })
        }))
      } else {
        const streakInlineStartedAt = performance.now()
        await recordStreak()
        streakInlineMs = elapsedMs(streakInlineStartedAt)
      }
    }
    timingOutcome = outcome
    resultForTiming = {
      attempts_remaining: attemptsRemaining,
      ...(type === "translation_choice" && (outcome === "correct" || outcome === "revealed") && exercise.correct_option_id
        ? { correct_option_id: exercise.correct_option_id }
        : {}),
      exercise_id: exercise.id,
      ...(feedback ? { feedback } : {}),
      next_review_hint: fsrsRating,
      object: "song_study_attempt_result",
      outcome,
      ...(studyProgress ? { study_progress: studyProgress } : {}),
    }
    return resultForTiming
  } finally {
    const closeClientStartedAt = performance.now()
    await db.close()
    closeClientMs = elapsedMs(closeClientStartedAt)
    if (timingEnabled) {
      const timing: SongStudyAttemptTiming = {
        access_read_batch_ms: accessReadBatchMs,
        close_client_ms: closeClientMs,
        credential_probe_ms: credentialProbeMs,
        credential_source: credentialSource,
        community_id: input.communityId,
        due_review_count_ms: dueReviewCountMs,
        exercise_id: exerciseId,
        exercise_type: timingExerciseType,
        open_client_ms: openClientMs,
        outcome: timingOutcome,
        parallel_read_batch_ms: parallelReadBatchMs,
        post_id: input.postId,
        streak_target_count_ms: streakTargetCountMs,
        streak_deferred: timingStreakDeferred,
        streak_inline_ms: streakInlineMs,
        streak_writes_enabled: timingStreakWritesEnabled,
        total_ms: elapsedMs(timingStartedAt),
        wait_until_available: Boolean(input.waitUntil),
        write_tx_ms: writeTxMs,
      }
      if (resultForTiming) {
        Object.defineProperty(resultForTiming, SONG_STUDY_ATTEMPT_TIMING, {
          enumerable: false,
          value: timing,
        })
      }
      console.info("[song-study] attempt timing", JSON.stringify(timing))
    }
  }
}

type SongStreakRow = {
  best_streak: unknown
  current_streak: unknown
  last_qualified_date: unknown
  streak_started_date: unknown
  total_qualified_days: unknown
  user_id: unknown
}

type SongStreakDayRow = {
  karaoke_pass_count?: unknown
  post_id?: unknown
  qualified?: unknown
  study_attempt_count?: unknown
  study_target_count?: unknown
}

function utcDateFromIso(value: string): string {
  return value.slice(0, 10)
}

function addUtcDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00.000Z`)
  parsed.setUTCDate(parsed.getUTCDate() + days)
  return parsed.toISOString().slice(0, 10)
}

function placeholders(count: number, startIndex = 1): string {
  return Array.from({ length: count }, (_, index) => `?${startIndex + index}`).join(", ")
}

function clampStreakLeaderboardLimit(value?: number | null): number {
  if (value == null || !Number.isFinite(value)) return STREAK_LEADERBOARD_DEFAULT_LIMIT
  return Math.min(STREAK_LEADERBOARD_MAX_LIMIT, Math.max(1, Math.trunc(value)))
}

function profileIdentity(userId: string, profile: Profile | null | undefined): SongStreakLeaderboardIdentity | null {
  if (!profile) return null
  return {
    avatar_ref: profile.avatar_ref ?? null,
    display_name: profile.display_name ?? null,
    handle: profile.primary_public_handle?.label ?? profile.global_handle?.label ?? null,
    user_id: userId,
  }
}

async function resolveLeaderboardIdentities(
  profileRepository: ProfileRepository,
  userIds: string[],
): Promise<Map<string, SongStreakLeaderboardIdentity>> {
  const uniqueUserIds = Array.from(new Set(userIds.map((userId) => userId.trim()).filter(Boolean)))
  const profiles = profileRepository.listProfilesByUserIds
    ? await profileRepository.listProfilesByUserIds(uniqueUserIds)
    : new Map(await Promise.all(uniqueUserIds.map(async (userId) => [userId, await profileRepository.getProfileByUserId(userId)] as const)))
  const identities = new Map<string, SongStreakLeaderboardIdentity>()
  for (const userId of uniqueUserIds) {
    const identity = profileIdentity(userId, profiles.get(userId))
    if (identity) {
      identities.set(userId, identity)
    }
  }
  return identities
}

function viewerStanding(input: {
  day: SongStreakDayRow | null
  row: SongStreakRow | null
  today: string
  yesterday: string
}): SongStreakViewerStanding {
  const lastQualifiedDate = readString(input.row?.last_qualified_date)
  return {
    alive: Boolean(lastQualifiedDate && lastQualifiedDate >= input.yesterday),
    best_streak: Number(input.row?.best_streak ?? 0),
    current_streak: Number(input.row?.current_streak ?? 0),
    karaoke_passed_today: Number(input.day?.karaoke_pass_count ?? 0) > 0,
    qualified_today: Number(input.day?.qualified ?? 0) === 1,
    study_attempts_today: Number(input.day?.study_attempt_count ?? 0),
    study_target_today: Number(input.day?.study_target_count ?? STREAK_MIN_STUDY_ATTEMPTS),
    total_qualified_days: Number(input.row?.total_qualified_days ?? 0),
  }
}

async function readSongStreakSummary(input: {
  client: Client
  limit: number
  postId: string
  profileRepository: ProfileRepository
  userId: string
}): Promise<{ date: string; summary: SongStreakSummary }> {
  const today = utcDateFromIso(nowIso())
  const yesterday = addUtcDays(today, -1)
  const [boardResult, totalActiveRow, viewerRow, viewerDay] = await Promise.all([
    input.client.execute({
      sql: `
        SELECT user_id, current_streak, best_streak, streak_started_date, total_qualified_days, last_qualified_date
        FROM song_streaks
        WHERE post_id = ?1
          AND last_qualified_date >= ?2
        ORDER BY current_streak DESC, best_streak DESC, streak_started_date ASC, user_id ASC
        LIMIT ?3
      `,
      args: [input.postId, yesterday, input.limit + STREAK_LEADERBOARD_OVERFETCH],
    }),
    executeFirst(input.client, {
      sql: `
        SELECT COUNT(*) AS active_count
        FROM song_streaks
        WHERE post_id = ?1
          AND last_qualified_date >= ?2
      `,
      args: [input.postId, yesterday],
    }) as Promise<Record<string, unknown> | null>,
    executeFirst(input.client, {
      sql: `
        SELECT user_id, current_streak, best_streak, streak_started_date, total_qualified_days, last_qualified_date
        FROM song_streaks
        WHERE user_id = ?1
          AND post_id = ?2
      `,
      args: [input.userId, input.postId],
    }) as Promise<SongStreakRow | null>,
    executeFirst(input.client, {
      sql: `
        SELECT qualified, study_attempt_count, study_target_count, karaoke_pass_count
        FROM song_engagement_days
        WHERE user_id = ?1
          AND post_id = ?2
          AND activity_date = ?3
      `,
      args: [input.userId, input.postId, today],
    }) as Promise<SongStreakDayRow | null>,
  ])

  const rows = boardResult.rows as SongStreakRow[]
  const identities = await resolveLeaderboardIdentities(
    input.profileRepository,
    rows.map((row) => readString(row.user_id) ?? ""),
  )
  const entries: SongStreakLeaderboardEntry[] = []
  for (const row of rows) {
    const userId = readString(row.user_id)
    if (!userId) continue
    const identity = identities.get(userId)
    if (!identity) continue
    entries.push({
      best_streak: Number(row.best_streak ?? 0),
      current_streak: Number(row.current_streak ?? 0),
      identity,
      is_viewer: userId === input.userId,
      last_qualified_date: readString(row.last_qualified_date) ?? today,
      rank: entries.length + 1,
      streak_started_date: readString(row.streak_started_date) ?? today,
      total_qualified_days: Number(row.total_qualified_days ?? 0),
    })
    if (entries.length >= input.limit) break
  }

  return {
    date: today,
    summary: {
      entries,
      total_active_streaks: Number(totalActiveRow?.active_count ?? 0),
      viewer: viewerStanding({ day: viewerDay, row: viewerRow, today, yesterday }),
    },
  }
}

export async function listPostStreakSummaries(input: {
  client: Client
  limit?: number | null
  postIds: string[]
  profileRepository: ProfileRepository
  userId: string
}): Promise<Map<string, SongStreakSummary>> {
  const postIds = Array.from(new Set(input.postIds.map((postId) => postId.trim()).filter(Boolean)))
  if (postIds.length === 0) return new Map()

  const limit = clampStreakLeaderboardLimit(input.limit ?? 3)
  const today = utcDateFromIso(nowIso())
  const yesterday = addUtcDays(today, -1)
  const postIdPlaceholders = placeholders(postIds.length)
  const activeDateIndex = postIds.length + 1
  const rowLimitIndex = postIds.length + 2

  const [boardResult, totalActiveResult, viewerResult, viewerDayResult] = await Promise.all([
    input.client.execute({
      sql: `
        SELECT post_id, user_id, current_streak, best_streak, streak_started_date,
               total_qualified_days, last_qualified_date, board_rank
        FROM (
          SELECT post_id, user_id, current_streak, best_streak, streak_started_date,
                 total_qualified_days, last_qualified_date,
                 ROW_NUMBER() OVER (
                   PARTITION BY post_id
                   ORDER BY current_streak DESC, best_streak DESC, streak_started_date ASC, user_id ASC
                 ) AS board_rank
          FROM song_streaks
          WHERE post_id IN (${postIdPlaceholders})
            AND last_qualified_date >= ?${activeDateIndex}
        )
        WHERE board_rank <= ?${rowLimitIndex}
        ORDER BY post_id ASC, board_rank ASC
      `,
      args: [...postIds, yesterday, limit + STREAK_LEADERBOARD_OVERFETCH],
    }),
    input.client.execute({
      sql: `
        SELECT post_id, COUNT(*) AS active_count
        FROM song_streaks
        WHERE post_id IN (${postIdPlaceholders})
          AND last_qualified_date >= ?${activeDateIndex}
        GROUP BY post_id
      `,
      args: [...postIds, yesterday],
    }),
    input.client.execute({
      sql: `
        SELECT post_id, user_id, current_streak, best_streak, streak_started_date,
               total_qualified_days, last_qualified_date
        FROM song_streaks
        WHERE user_id = ?1
          AND post_id IN (${placeholders(postIds.length, 2)})
      `,
      args: [input.userId, ...postIds],
    }),
    input.client.execute({
      sql: `
        SELECT post_id, qualified, study_attempt_count, study_target_count, karaoke_pass_count
        FROM song_engagement_days
        WHERE user_id = ?1
          AND post_id IN (${placeholders(postIds.length, 2)})
          AND activity_date = ?${postIds.length + 2}
      `,
      args: [input.userId, ...postIds, today],
    }),
  ])

  const boardRowsByPostId = new Map<string, SongStreakRow[]>()
  for (const row of boardResult.rows as SongStreakRow[]) {
    const postId = readString(rowValue(row, "post_id"))
    if (!postId) continue
    const rows = boardRowsByPostId.get(postId) ?? []
    rows.push(row)
    boardRowsByPostId.set(postId, rows)
  }

  const totalActiveByPostId = new Map<string, number>()
  for (const row of totalActiveResult.rows ?? []) {
    const postId = readString(rowValue(row, "post_id"))
    if (!postId) continue
    totalActiveByPostId.set(postId, Number(rowValue(row, "active_count") ?? 0))
  }

  const viewerRowsByPostId = new Map<string, SongStreakRow>()
  for (const row of viewerResult.rows as SongStreakRow[]) {
    const postId = readString(rowValue(row, "post_id"))
    if (!postId) continue
    viewerRowsByPostId.set(postId, row)
  }

  const viewerDaysByPostId = new Map<string, SongStreakDayRow>()
  for (const row of viewerDayResult.rows as SongStreakDayRow[]) {
    const postId = readString(rowValue(row, "post_id"))
    if (!postId) continue
    viewerDaysByPostId.set(postId, row)
  }

  const identityUserIds = Array.from(new Set(
    [...boardRowsByPostId.values()]
      .flat()
      .map((row) => readString(row.user_id) ?? "")
      .filter(Boolean),
  ))
  const identities = await resolveLeaderboardIdentities(input.profileRepository, identityUserIds)

  const summaries = new Map<string, SongStreakSummary>()
  for (const postId of postIds) {
    const entries: SongStreakLeaderboardEntry[] = []
    for (const row of boardRowsByPostId.get(postId) ?? []) {
      const userId = readString(row.user_id)
      if (!userId) continue
      const identity = identities.get(userId)
      if (!identity) continue
      entries.push({
        best_streak: Number(row.best_streak ?? 0),
        current_streak: Number(row.current_streak ?? 0),
        identity,
        is_viewer: userId === input.userId,
        last_qualified_date: readString(row.last_qualified_date) ?? today,
        rank: entries.length + 1,
        streak_started_date: readString(row.streak_started_date) ?? today,
        total_qualified_days: Number(row.total_qualified_days ?? 0),
      })
      if (entries.length >= limit) break
    }

    summaries.set(postId, {
      entries,
      total_active_streaks: totalActiveByPostId.get(postId) ?? 0,
      viewer: viewerStanding({
        day: viewerDaysByPostId.get(postId) ?? null,
        row: viewerRowsByPostId.get(postId) ?? null,
        today,
        yesterday,
      }),
    })
  }

  return summaries
}

function isMissingStreakTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /no such table:\s*(song_streaks|song_engagement_days)/iu.test(message)
}

export async function getPostStreakSummary(input: {
  client: Client
  postId: string
  profileRepository: ProfileRepository
  userId: string | null
}): Promise<SongStreakSummary | null> {
  if (!input.userId) return null
  const post = await getStudyPostById(input.client, input.postId)
  if (!post || post.post_type !== "song" || post.status !== "published") return null
  try {
    await requireMemberAccess(input.client, post.community_id, input.userId)
  } catch (error) {
    if (isMissingStreakTableError(error)) return null
    if (error instanceof HttpError && error.status === 404) return null
    throw error
  }
  try {
    return (await readSongStreakSummary({
      client: input.client,
      limit: 3,
      postId: input.postId,
      profileRepository: input.profileRepository,
      userId: input.userId,
    })).summary
  } catch (error) {
    if (isMissingStreakTableError(error)) return null
    throw error
  }
}

export async function getPostStreakLeaderboard(input: {
  actor: ActorContext | AdminActorContext
  communityId: string
  communityRepository: CommunityDatabaseBindingRepository
  env: Env
  limit?: number | null
  postId: string
  profileRepository: ProfileRepository
}): Promise<SongStreakLeaderboard> {
  const limit = clampStreakLeaderboardLimit(input.limit)
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    const post = await getStudyPostById(db.client, input.postId)
    if (!post || post.community_id !== input.communityId) throw notFoundError("Post not found")
    await requireMemberAccess(db.client as Client, input.communityId, input.actor.userId)
    if (post.status !== "published" && !await canReadPostForStudy({ actor: input.actor, client: db.client, post })) {
      throw notFoundError("Post not found")
    }

    const { date, summary } = await readSongStreakSummary({
      client: db.client as Client,
      limit,
      postId: input.postId,
      profileRepository: input.profileRepository,
      userId: input.actor.userId,
    })

    return {
      community_id: publicCommunityId(input.communityId),
      date,
      entries: summary.entries,
      object: "song_streak_leaderboard",
      post_id: publicPostId(input.postId),
      total_active_streaks: summary.total_active_streaks,
      viewer: summary.viewer,
    }
  } finally {
    await db.close()
  }
}

export async function transcribePostStudyAudio(input: {
  actor: ActorContext | AdminActorContext
  communityId: string
  communityRepository: CommunityDatabaseBindingRepository
  env: Env
  file: File
  postId: string
}): Promise<SongStudyTranscriptionResponse> {
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    if (!await isCommunityStudyEnabled({ executor: db.client, communityId: input.communityId })) {
      throw new HttpError(403, "forbidden", "Study is disabled for this community")
    }

    const post = await getStudyPostById(db.client, input.postId)
    if (!post || post.community_id !== input.communityId) throw notFoundError("Post not found")
    if (!await canReadPostForStudy({ actor: input.actor, client: db.client, post })) {
      throw notFoundError("Post not found")
    }
    if (post.post_type !== "song") {
      throw notFoundError("Study is not available")
    }
    if (!await canStudyPost({ actor: input.actor, client: db.client, communityId: input.communityId, post })) {
      throw new HttpError(403, "forbidden", "Caller is not entitled to study this post")
    }
  } finally {
    await db.close()
  }

  const transcription = await transcribeCommunityAudioWithElevenLabs({
    communityId: input.communityId,
    env: input.env,
    file: input.file,
    missingCredentialMessage: "An ElevenLabs API key is required for say-it-back transcription",
  })
  return {
    confidence: transcription.confidence,
    duration_seconds: transcription.duration_seconds,
    language_code: transcription.language_code,
    language_probability: transcription.language_probability,
    model: transcription.model,
    object: "song_study_transcription",
    provider: transcription.provider,
    text: transcription.text,
  }
}
