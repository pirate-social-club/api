import type { ActorContext, AdminActorContext } from "../auth-middleware"
import type { Env } from "../../env"
import type { SongFeatureCapabilityReason } from "../../types"
import type { ProfileRepository } from "../auth/repositories"
import { badRequestError, conflictError, HttpError, notFoundError } from "../errors"
import { executeFirst, type DbExecutor } from "../db-helpers"
import { envFlag, makeId, nowIso } from "../helpers"
import type { Client, InStatement, ReadClient } from "../sql-client"
import { getActiveEntitlementForBuyer } from "../communities/commerce/shared"
import type { CommunityJobHandlerInput } from "../communities/jobs/handler-types"
import { parseJobPayload } from "../communities/jobs/payload"
import { isCommunityStudyEnabled } from "../communities/community-study-policy-service"
import type { CommunityDatabaseBindingRepository } from "../communities/community-repository-types"
import { openCommunityWriteClient } from "../communities/community-read-access"
import {
  getCommunityElevenLabsStudyCapability,
  hasActiveCommunityElevenLabsCredential,
  type CommunityElevenLabsStudyCapability,
} from "../communities/assistant-policy/credential-service"
import { transcribeCommunityAudioWithElevenLabs } from "../communities/assistant-policy/speech-service"
import { canGenerateStudyTranslations, requestStudyPackGeneration, type StudyGeneratedLine } from "./post-study-generation-provider"
import {
  chunkStudyGenerationLines,
  classifyStudyGenerationError,
  compactGenerationResultRef,
  orderedTranslationOptions,
  studyGenerationChunkSize,
} from "./post-study-generation-helpers"
import { canReadNonPublishedPost, isPubliclyReadablePost, requireMemberAccess } from "./post-access"
import { publicCommunityId, publicPostId } from "../public-ids"
import { withTransaction } from "../transactions"
import { logPipelineError } from "../observability/pipeline-log"
import { emitStudyQualificationIfComplete } from "../rewards/reward-qualification-outbox"
import { fsrsRatingFor, gradeSayItBack, type AttemptOutcome, type FsrsRating } from "./post-study-recall-grading"
import {
  ensureStudyUnits,
  selectStudyUnits,
  splitLyricsForStudy,
  STUDY_UNIT_GENERATION_VERSION,
  studyWordCount,
  type StudyUnitRow,
} from "./post-study-unit-service"
import {
  enqueueStudyGenerationIfNeeded,
  getLatestPack,
  hasCompleteReadyStudyLocalizations,
  isSameLanguageStudyPair,
  normalizeStudyTargetLanguage,
  STUDY_LOCALIZATION_GENERATION_VERSION,
  type StudyPack,
  type StudyUnavailableReason,
} from "./post-study-localization-service"
import {
  clampStreakLeaderboardLimit,
  readSongStreakSummary,
  studyActivityDate,
  STUDY_FALLBACK_TIMEZONE,
  STREAK_MIN_STUDY_ATTEMPTS,
  type SongStreakLeaderboardEntry,
  type SongStreakSummary,
  type SongStreakViewerStanding,
} from "./post-study-streak-read-service"

export { listPostStreakSummaries } from "./post-study-streak-read-service"
export type { SongStreakSummary } from "./post-study-streak-read-service"

type StudyAccess = "ready" | "locked" | "processing" | "unavailable"
type ExerciseType = "say_it_back" | "translation_choice"

const FSRS_PARAMS_VERSION = 1
const STUDY_SESSION_EXERCISE_LIMIT = 15

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

type StudyCapabilityPost = {
  access_mode?: "public" | "locked" | null
  asset_id?: string | null
  author_user_id?: string | null
  community_id: string
  lyrics?: string | null
  post_id: string
  post_type: string
  song_cover_art_ref?: string | null
  song_title?: string | null
  source_language?: string | null
  title?: string | null
}

export type PostStudyCapability = {
  exercise_count?: number | null
  reasons?: SongFeatureCapabilityReason[]
  source_language?: string | null
  status: StudyAccess
  target_language?: string | null
}

type StudyExerciseAvailability = {
  access: Exclude<StudyAccess, "locked">
  canonicalExerciseRows: StudyExerciseRow[]
  exerciseCount: number
  includeSayItBack: boolean
  includeTranslation: boolean
  pack: StudyPack | null
  unavailableReason?: StudyUnavailableReason
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

function studyUnavailableReason(reason: StudyUnavailableReason | undefined): SongFeatureCapabilityReason {
  switch (reason) {
    case "missing_transcription_provider":
      return { code: "provider_key_missing", kind: "config", owner_action: "manage_integrations" }
    case "generation_failed":
      return { code: "exercise_generation_failed", kind: "processing_failure", owner_action: "retry" }
    case "no_lyrics":
    default:
      return { code: "lyrics_missing", kind: "content", owner_action: "edit_song" }
  }
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

type SongStudyExercise =
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

type SongStudySessionSummary = {
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

type SongStudyAttemptProgress = {
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

export type SongStreakLeaderboard = {
  community_id: string
  date: string
  entries: SongStreakLeaderboardEntry[]
  object: "song_streak_leaderboard"
  post_id: string
  total_active_streaks: number
  viewer: SongStreakViewerStanding | null
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  return trimmed || null
}

function readRequiredString(value: unknown, field: string): string {
  const trimmed = readString(value)
  if (!trimmed) throw badRequestError(`${field} is required`)
  return trimmed
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
// Cloudflare exposes the client's IANA timezone on `request.cf.timezone`. A US
// learner studying at 21:00 local writes their streak day in their own calendar,
// not the UTC calendar — so activity_date and streak continuation are computed in
// this timezone. Falls back to UTC when cf is unavailable (local dev, tests).
export function resolveStudyTimezone(cf: Request["cf"] | undefined): string {
  const tz = typeof cf?.timezone === "string" ? cf.timezone.trim() : ""
  if (!tz) return STUDY_FALLBACK_TIMEZONE
  try {
    // Validate the IANA zone by formatting; invalid zones throw RangeError.
    new Intl.DateTimeFormat("en-CA", { timeZone: tz })
    return tz
  } catch {
    return STUDY_FALLBACK_TIMEZONE
  }
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

async function canStudyCapabilityPost(input: {
  client: DbExecutor
  post: StudyCapabilityPost
  viewerUserId?: string | null
}): Promise<boolean> {
  if (input.post.access_mode !== "locked") return true
  if (input.post.author_user_id && input.viewerUserId === input.post.author_user_id) return true
  if (!input.viewerUserId || !input.post.asset_id) return false
  const entitlement = await getActiveEntitlementForBuyer(
    input.client,
    input.post.community_id,
    input.viewerUserId,
    input.post.asset_id,
    "asset_access",
  )
  return Boolean(entitlement)
}

function virtualStudyUnitsFromLyrics(post: StudyCapabilityPost): StudyUnitRow[] {
  return splitLyricsForStudy(post.lyrics ?? null).map((line) => ({
    id: `virtual:${post.post_id}:${line.lineId}`,
    line_id: line.lineId,
    line_index: line.lineIndex,
    max_attempts: 2,
    prompt_text: line.text,
    reference_text: line.text,
    say_it_back_status: "ready",
    source_language: post.source_language ?? null,
    unit_version: STUDY_UNIT_GENERATION_VERSION,
  }))
}

async function resolveCapabilityStudyUnits(input: {
  client: DbExecutor
  post: StudyCapabilityPost
}): Promise<{ persisted: boolean; units: StudyUnitRow[] }> {
  const existing = await selectStudyUnits(input.client, input.post.post_id)
  if (existing.length > 0 && existing.every((unit) => unit.unit_version >= STUDY_UNIT_GENERATION_VERSION)) {
    return { persisted: true, units: existing }
  }
  return {
    persisted: false,
    units: virtualStudyUnitsFromLyrics(input.post),
  }
}

async function resolveHasActiveElevenLabsCredential(input: {
  communityId: string
  env?: Env | null
  hasActiveElevenLabsCredential?: ((communityId: string) => Promise<boolean>)
}): Promise<boolean> {
  if (input.hasActiveElevenLabsCredential) {
    return input.hasActiveElevenLabsCredential(input.communityId)
  }
  if (!input.env) return false
  return hasActiveCommunityElevenLabsCredential({
    env: input.env,
    communityId: input.communityId,
  })
}

async function resolveStudyExerciseAvailability(input: {
  client: DbExecutor
  env?: Env | null
  hasActiveElevenLabsCredential?: ((communityId: string) => Promise<boolean>)
  post: StudyCapabilityPost
  targetLanguage: string
  units: StudyUnitRow[]
  unitsPersisted: boolean
}): Promise<StudyExerciseAvailability> {
  const includeTranslation = !isSameLanguageStudyPair(input.post.source_language, input.targetLanguage)
  const includeSayItBack = await resolveHasActiveElevenLabsCredential({
    communityId: input.post.community_id,
    env: input.env,
    hasActiveElevenLabsCredential: input.hasActiveElevenLabsCredential,
  })
  const pack = input.unitsPersisted
    ? await getLatestPack({
      client: input.client,
      postId: input.post.post_id,
      targetLanguage: input.targetLanguage,
    })
    : null
  if (includeTranslation && pack?.status === "unavailable") {
    return {
      access: "unavailable",
      canonicalExerciseRows: [],
      exerciseCount: 0,
      includeSayItBack,
      includeTranslation,
      pack,
      unavailableReason: pack.unavailable_reason ?? "generation_failed",
    }
  }

  const canonicalExerciseRows = input.unitsPersisted
    ? await listExercises({
      client: input.client,
      dueReviewServing: false,
      includeSayItBack,
      includeTranslation,
      now: nowIso(),
      postId: input.post.post_id,
      targetLanguage: input.targetLanguage,
    })
    : []
  const virtualSayItBackCount = !input.unitsPersisted && includeSayItBack
    ? input.units.length
    : 0
  const exerciseCount = canonicalExerciseRows.length + virtualSayItBackCount
  if (exerciseCount > 0) {
    return {
      access: "ready",
      canonicalExerciseRows,
      exerciseCount,
      includeSayItBack,
      includeTranslation,
      pack,
    }
  }

  if (!includeSayItBack && includeTranslation && input.env && canGenerateStudyTranslations(input.env)) {
    return {
      access: "processing",
      canonicalExerciseRows,
      exerciseCount: 0,
      includeSayItBack,
      includeTranslation,
      pack,
    }
  }

  return {
    access: "unavailable",
    canonicalExerciseRows,
    exerciseCount: 0,
    includeSayItBack,
    includeTranslation,
    pack,
    unavailableReason: includeSayItBack ? "no_lyrics" : "missing_transcription_provider",
  }
}

export async function resolvePostStudyCapability(input: {
  client: DbExecutor
  env?: Env | null
  hasActiveElevenLabsCredential?: ((communityId: string) => Promise<boolean>)
  post: StudyCapabilityPost
  targetLanguage?: string | null
  viewerUserId?: string | null
}): Promise<PostStudyCapability | null> {
  if (input.post.post_type !== "song") return null
  let targetLanguage: string
  try {
    targetLanguage = normalizeStudyTargetLanguage(input.targetLanguage)
  } catch {
    return {
      source_language: input.post.source_language,
      status: "unavailable",
      target_language: null,
    }
  }
  const base = {
    source_language: input.post.source_language,
    target_language: targetLanguage,
  }

  if (!await canStudyCapabilityPost({
    client: input.client,
    post: input.post,
    viewerUserId: input.viewerUserId,
  })) {
    return {
      ...base,
      reasons: [{ code: "locked", kind: "entitlement", owner_action: "buy" }],
      status: "locked",
    }
  }

  const { persisted, units } = await resolveCapabilityStudyUnits({
    client: input.client,
    post: input.post,
  })
  if (units.length === 0) {
    return {
      ...base,
      reasons: [{ code: "lyrics_missing", kind: "content", owner_action: "edit_song" }],
      status: "unavailable",
    }
  }

  const availability = await resolveStudyExerciseAvailability({
    client: input.client,
    env: input.env,
    hasActiveElevenLabsCredential: input.hasActiveElevenLabsCredential,
    post: input.post,
    targetLanguage,
    units,
    unitsPersisted: persisted,
  })
  return {
    ...base,
    ...(availability.exerciseCount > 0 ? { exercise_count: availability.exerciseCount } : {}),
    ...(availability.access === "unavailable" ? { reasons: [studyUnavailableReason(availability.unavailableReason)] } : {}),
    status: availability.access,
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
  client: DbExecutor
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
             0 AS sort_order,
             CASE WHEN ?6 = 1 AND s.user_id IS NOT NULL AND s.due_at <= ?7 THEN 0 ELSE 1 END AS due_rank
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
             1 AS sort_order,
             CASE WHEN ?6 = 1 AND s.user_id IS NOT NULL AND s.due_at <= ?7 THEN 0 ELSE 1 END AS due_rank
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
      ORDER BY due_rank ASC, line_index ASC, sort_order ASC, id ASC
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
    await enqueueStudyGenerationIfNeeded({
      client: db.client,
      communityId: input.communityId,
      env: input.env,
      postId: input.postId,
      sourceLanguage: post.source_language,
      targetLanguage,
      units,
    })

    const availability = await resolveStudyExerciseAvailability({
      client: db.client,
      env: input.env,
      post,
      targetLanguage,
      units,
      unitsPersisted: true,
    })
    const pack = availability.pack
    if (availability.access === "unavailable" && availability.unavailableReason === "generation_failed") {
      return {
        ...basePayload({ access: "unavailable", post, targetLanguage: pack?.target_language ?? targetLanguage }),
        source_language: pack?.source_language ?? post.source_language,
        unavailable_reason: availability.unavailableReason,
      }
    }

    const includeSayItBack = availability.includeSayItBack
    const includeTranslation = availability.includeTranslation
    const now = nowIso()
    const reServeDueReviews = dueReviewServingEnabled(input.env)
    const canonicalExerciseRows = availability.canonicalExerciseRows
    const eligibleExerciseRows = await listExercises({
      client: db.client,
      dueReviewServing: reServeDueReviews,
      includeSayItBack,
      includeTranslation,
      now,
      postId: input.postId,
      targetLanguage,
      userId: input.actor.userId,
    })
    const exerciseRows = eligibleExerciseRows.slice(0, STUDY_SESSION_EXERCISE_LIMIT)
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
      due_count: eligibleExerciseRows.length,
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
      if (availability.access === "processing") {
        return {
          ...basePayload({ access: "processing", post, targetLanguage }),
          source_language: pack?.source_language ?? post.source_language,
        }
      }
      return {
        ...basePayload({ access: "unavailable", post, targetLanguage }),
        source_language: pack?.source_language ?? post.source_language,
        unavailable_reason: availability.unavailableReason ?? (includeSayItBack ? "no_lyrics" : "missing_transcription_provider"),
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

async function upsertStudyEngagementDay(input: {
  client: ReadClient
  communityId: string
  isCorrect: boolean
  now: string
  postId: string
  studyTargetCount: number
  studyTimezone?: string
  userId: string
}): Promise<void> {
  const activityTimezone = input.studyTimezone ?? STUDY_FALLBACK_TIMEZONE
  const today = studyActivityDate(input.now, activityTimezone)
  const isCorrect = input.isCorrect ? 1 : 0
  await input.client.execute({
    sql: `
      INSERT INTO song_engagement_days (
        user_id, post_id, community_id, activity_date, activity_timezone,
        study_attempt_count, study_correct_count, study_target_count,
        karaoke_pass_count, qualified, created_at, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, ?8, 1, ?5, ?6, 0, CASE WHEN ?5 >= ?6 THEN 1 ELSE 0 END, ?7, ?7)
      ON CONFLICT(user_id, post_id, activity_date) DO UPDATE SET
        activity_timezone = excluded.activity_timezone,
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
      activityTimezone,
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
  studyTimezone?: string
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
  const today = studyActivityDate(input.now, input.studyTimezone ?? STUDY_FALLBACK_TIMEZONE)
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
  studyTimezone?: string
  userId: string
}): Promise<SongStudyAttemptProgress | undefined> {
  const today = studyActivityDate(input.now, input.studyTimezone ?? STUDY_FALLBACK_TIMEZONE)
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
      studyTimezone: input.studyTimezone,
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

async function materializeStudyStreak(input: {
  activityDate?: string
  client: ReadClient
  now: string
  postId: string
  studyTimezone?: string
  userId: string
}): Promise<void> {
  const today = input.activityDate ?? studyActivityDate(input.now, input.studyTimezone ?? STUDY_FALLBACK_TIMEZONE)
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
  studyTimezone?: string
  userId: string
}): Promise<void> {
  await upsertStudyEngagementDay(input)
  await materializeStudyStreak(input)
}

async function resolveStudyStreakTargetCount(input: {
  client: ReadClient
  communityId: string
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
  // The streak target must be the SAME eligible set GET serves (due reviews +
  // unattempted new cards for this user, with due-review serving honored), so the
  // bar is deterministic regardless of which card the learner grades first. The
  // old branch made the target swing between min(10, due) and min(10, serveable)
  // depending on the first graded attempt's path; that nondeterminism is what
  // froze an unpredictable bar on the day's first write.
  const exerciseCountStartedAt = performance.now()
  const reServeDueReviews = dueReviewServingEnabled(input.env)
  const exerciseCount = (await listExercises({
    client: input.client,
    dueReviewServing: reServeDueReviews,
    includeSayItBack,
    includeTranslation,
    now: input.now,
    postId: input.postId,
    targetLanguage: input.targetLanguage,
    userId: input.userId,
  })).length
  const dueReviewCountMs = elapsedMs(exerciseCountStartedAt)
  // If async generation has only produced a smaller ready set, that smaller pack
  // is the bar for this pilot day. study_target_count is frozen on the first
  // engagement-day INSERT (the ON CONFLICT path never updates it), so computing
  // it from the full eligible set — not a per-attempt subset — is what makes the
  // streak bar predictable across a mixed due+new session.
  return {
    count: studyTargetCountFromServeableExerciseCount(exerciseCount),
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
  studyTimezone?: string
  userId: string
}): Promise<void> {
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    await withTransaction(db.client, "write", async (tx) => {
      await materializeStudyStreak({
        client: tx,
        now: input.now,
        postId: input.postId,
        studyTimezone: input.studyTimezone,
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
  studyTimezone?: string
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
    const rewardQualificationWritesEnabled = envFlag(input.env.REWARDS_CAMPAIGNS_ENABLED, false)
      && envFlag(input.env.REWARDS_ACCRUAL_ENABLED, false)
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
    const studyStreakTarget = streakWritesEnabled || rewardQualificationWritesEnabled
      ? await resolveStudyStreakTargetCount({
        client: db.client,
        communityId: input.communityId,
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
          studyTimezone: input.studyTimezone,
          userId: input.actor.userId,
        })
      }
      if (rewardQualificationWritesEnabled && studyStreakTarget != null) {
        await emitStudyQualificationIfComplete({
          client: tx,
          communityId: input.communityId,
          now,
          postId: input.postId,
          targetCount: studyStreakTarget.count,
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
        studyTimezone: input.studyTimezone,
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
          studyTimezone: input.studyTimezone,
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

function isMissingStreakTableError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /no such table:\s*(song_streaks|song_engagement_days)/iu.test(message)
}

export async function getPostStreakSummary(input: {
  client: Client
  postId: string
  profileRepository: ProfileRepository
  studyTimezone?: string
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
      studyTimezone: input.studyTimezone,
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
  studyTimezone?: string
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
      studyTimezone: input.studyTimezone,
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

  if (!await hasActiveCommunityElevenLabsCredential({
    env: input.env,
    communityId: input.communityId,
  })) {
    throw badRequestError("An ElevenLabs API key is required for say-it-back transcription")
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
