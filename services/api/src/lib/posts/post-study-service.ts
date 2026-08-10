import type { ActorContext, AdminActorContext } from "../auth-middleware"
import type { Env } from "../../env"
import type { SongFeatureCapabilityReason } from "../../types"
import type { ProfileRepository, UserRepository } from "../auth/repositories"
import { badRequestError, codedConflictError, conflictError, HttpError, notFoundError } from "../errors"
import { executeFirst, type DbExecutor } from "../db-helpers"
import { envFlag, makeId, nowIso } from "../helpers"
import { resolveStoredSourceLanguage } from "../localization/content-locale"
import type { Client, ReadClient } from "../sql-client"
import { getActiveEntitlementForBuyer } from "../communities/commerce/shared"
import type { CommunityJobHandlerInput } from "../communities/jobs/handler-types"
import { parseJobPayload } from "../communities/jobs/payload"
import { COMMUNITY_JOB_MAX_ATTEMPTS } from "../communities/jobs/runner-types"
import { isCommunityStudyEnabled } from "../communities/community-study-policy-service"
import type { CommunityDatabaseBindingRepository } from "../communities/community-repository-types"
import { openCommunityWriteClient } from "../communities/community-read-access"
import {
  hasActiveCommunityElevenLabsCredential,
} from "../communities/assistant-policy/credential-service"
import {
  isClearSpeechLanguageMismatch,
  normalizeSpeechLanguageCode,
  transcribeCommunityAudioWithElevenLabs,
} from "../communities/assistant-policy/speech-service"
import {
  getAttemptByIdempotencyKey,
  getAttemptBySessionPresentation,
  getExerciseForAttempt,
  getReviewState,
  readString,
  upsertReviewState,
  type ExerciseType,
  type StudyAttemptRow,
  type StudyExerciseRow,
} from "./post-study-attempt-store"
import { classifyStudyGenerationError } from "./post-study-generation-helpers"
import {
  canReadPostForStudy,
  canStudyPost,
  getStudyPostById,
  repairStudyPostMetadata,
  type StudyPost,
} from "./post-study-access"
import { requireAgeGateAccess } from "./age-gate-viewer-state"
import { getUserRepository } from "../auth/repositories"
import { getNextDueAt, listExercises } from "./post-study-exercise-query"
import {
  ensureStudySession,
  applyPlannedStudyTransition,
  getStudyLessonTransitionState,
  getStudySessionSummary,
  loadStudyTransitionSessionState,
  requireStudySessionForAttempt,
  STUDY_SESSION_DISTINCT_EXERCISE_LIMIT,
  STUDY_SESSION_MAX_CARD_PRESENTATIONS,
  type StudySessionExerciseProgress,
  type StudySessionSummary,
} from "./post-study-session-service"
import {
  getStudyAttemptResponseSnapshot,
  finalizeStudyAttemptResponseSnapshot,
  buildStudyResponseSnapshotCasStatement,
  hasUngradableReceipt,
  recordOwnedUngradableReceipt,
  studyAttemptRequestFingerprint,
} from "./post-study-orchestration-store"
import {
  hasStudyRevisionConflict,
  planGradedStudyTransition,
  planUngradableStudyTransition,
} from "./post-study-transition-planner"
import { canGenerateStudyTranslations } from "./post-study-generation-provider"
import { requireMemberAccess } from "./post-access"
import { publicCommunityId, publicPostId } from "../public-ids"
import { withTransaction } from "../transactions"
import { emitStudyQualificationIfComplete } from "../rewards/reward-qualification-outbox"
import { deferRewardQualificationWakeup } from "../rewards/reward-qualification-wakeup"
import { fsrsRatingFor, gradeSayItBack, type AttemptOutcome, type FsrsRating } from "./post-study-recall-grading"
import {
  ensureStudyUnits,
  selectStudyUnits,
  splitLyricsForStudy,
  studyUnitsAreCurrent,
  STUDY_UNIT_GENERATION_VERSION,
  type StudyUnitRow,
} from "./post-study-unit-service"
import {
  createReadyStudyPack,
  completeStudyGenerationRun,
  enqueueStudyGenerationIfNeeded,
  getLatestPack,
  hasCompleteReadyStudyLocalizations,
  isSameLanguageStudyPair,
  markStudyGenerationRunRunning,
  normalizeStudyTargetLanguage,
  recordStudyGenerationRunFailure,
  type StudyPack,
  type StudyUnavailableReason,
} from "./post-study-localization-service"
import {
  clampStreakLeaderboardLimit,
  readSongStreakSummary,
  type SongStreakLeaderboardEntry,
  type SongStreakSummary,
  type SongStreakViewerStanding,
} from "./post-study-streak-read-service"
import {
  isValidIanaTimezone,
  studyActivityDate,
  STUDY_FALLBACK_TIMEZONE,
} from "./post-study-streak-time"
import { claimStreakTimezonePin, prepareStreakWrite, recordCompletedSessionStreak } from "./post-study-streak-write-service"

export { listPostStreakSummaries } from "./post-study-streak-read-service"
export type { SongStreakSummary } from "./post-study-streak-read-service"

type StudyAccess = "ready" | "locked" | "processing" | "unavailable"

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
  stored_source_language?: string | null
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

type SongStudyExercise =
  | {
      id: string
      line_id: string
      line_index: number
    max_attempts: number
    presentation_count: number
    mastered: boolean
    first_outcome: AttemptOutcome | null
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
    presentation_count: number
    mastered: boolean
    first_outcome: AttemptOutcome | null
      options: Array<{ id: string; text: string }>
      prompt_text: string
      question: string
      type: "translation_choice"
    }

type SongStudySessionSummary = StudySessionSummary

export type SongStudyPayload = {
  access: StudyAccess
  artist_name?: string | null
  artwork_src?: string | null
  community_id: string
  exercise_count: number
  exercises: SongStudyExercise[]
  generated_at?: number
  locked_reason?: "purchase_required" | "membership_required" | "age_required"
  lesson?: SongStudyLessonState
  object: "song_study_payload"
  post_id: string
  session?: SongStudySessionSummary
  source_language?: string | null
  study_pack_version?: number
  target_language?: string | null
  title: string
  translation_status?: "not_applicable" | "processing" | "ready" | "unavailable"
  unavailable_reason?: StudyUnavailableReason
}

export type SongStudyAttemptRequest = {
  attempt_number?: unknown
  exercise_id?: unknown
  idempotency_key?: unknown
  session_id?: unknown
  session_revision?: unknown
  selected_option_id?: unknown
  transcription_language_code?: unknown
  transcription_language_probability?: unknown
  timezone?: unknown
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
  lesson?: SongStudyLessonState
  outcome: AttemptOutcome | "ungradable"
  session?: SongStudySessionSummary
  study_progress?: SongStudyAttemptProgress
}

type SongStudyLessonState = {
  completion_reason: "all_resolved" | "presentation_budget" | null
  next: null | {
    attempts_this_appearance: number
    exercise_id: string
    is_reappearance: boolean
    presentation_number: number
    prompt: SongStudyExercise
    retry_in_place: boolean
    type: ExerciseType
  }
  resolved_count: number
  serving_index: number
  session_revision: number
  total_count: number
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
  community_id: string
  credential_probe_ms?: number
  credential_source?: "community" | "platform"
  due_review_count_ms?: number
  exercise_id: string
  exercise_type?: ExerciseType
  open_client_ms?: number
  outcome: string
  parallel_read_batch_ms?: number
  post_id: string
  streak_target_count_ms?: number
  streak_writes_enabled: boolean
  total_ms: number
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

function readOptionalSessionRevision(value: unknown): number | undefined {
  if (value == null) return undefined
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw badRequestError("session_revision must be a non-negative integer")
  }
  return value
}

function readOptionalTranscriptionLanguageCode(value: unknown): string | null {
  if (value == null) return null
  if (typeof value !== "string") {
    throw badRequestError("transcription_language_code must be a string")
  }
  const normalized = normalizeSpeechLanguageCode(value)
  if (!normalized) {
    throw badRequestError("transcription_language_code must be a valid ISO language code")
  }
  return normalized
}

function readOptionalTranscriptionLanguageProbability(value: unknown): number | null {
  if (value == null) return null
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw badRequestError("transcription_language_probability must be a number between 0 and 1")
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

function ungradableRerecordEnabled(env: Env): boolean {
  return envFlag(env.SONG_STUDY_UNGRADABLE_RERECORD_ENABLED, false)
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
  artifactWriteClient?: Client | null
  client: DbExecutor
  env?: Env | null
  post: StudyCapabilityPost
  targetLanguage: string
}): Promise<{ persisted: boolean; units: StudyUnitRow[] }> {
  const existing = await selectStudyUnits(input.client, input.post.post_id)
  const unitsCurrent = studyUnitsAreCurrent({
    lyrics: input.post.lyrics ?? null,
    post_id: input.post.post_id,
    source_language: input.post.source_language ?? null,
  }, existing)

  // Capability reads drive the video-feed actions, so stale units must heal here
  // rather than waiting for someone to open the Study route. Even current units
  // need the generation check: a localization-version bump can stale the pack
  // independently. Generation enqueueing is idempotent for post/language/version.
  if (input.env && input.artifactWriteClient) {
    try {
      const units = unitsCurrent
        ? existing
        : await ensureStudyUnits(input.artifactWriteClient, {
            lyrics: input.post.lyrics ?? null,
            post_id: input.post.post_id,
            source_language: input.post.source_language ?? null,
          })
      await enqueueStudyGenerationIfNeeded({
        client: input.artifactWriteClient,
        communityId: input.post.community_id,
        env: input.env,
        postId: input.post.post_id,
        sourceLanguage: input.post.source_language ?? null,
        targetLanguage: input.targetLanguage,
        units,
      })
      return { persisted: true, units }
    } catch (error) {
      console.error("[song-study] capability-triggered artifact healing failed", {
        error,
        post_id: input.post.post_id,
        target_language: input.targetLanguage,
      })
    }
  }

  if (unitsCurrent) return { persisted: true, units: existing }

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
  const [includeSayItBack, pack] = await Promise.all([
    resolveHasActiveElevenLabsCredential({
      communityId: input.post.community_id,
      env: input.env,
      hasActiveElevenLabsCredential: input.hasActiveElevenLabsCredential,
    }),
    input.unitsPersisted
      ? getLatestPack({
        client: input.client,
        postId: input.post.post_id,
        targetLanguage: input.targetLanguage,
        })
      : Promise.resolve(null),
  ])
  if (includeTranslation && !includeSayItBack && pack?.status === "unavailable") {
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

  const canonicalExerciseResult = input.unitsPersisted
    ? await listExercises({
      client: input.client,
      dueReviewServing: false,
      includeSayItBack,
      includeTranslation,
      now: nowIso(),
      postId: input.post.post_id,
      targetLanguage: input.targetLanguage,
    })
    : { rows: [], totalCount: 0 }
  const canonicalExerciseRows = canonicalExerciseResult.rows
  const virtualSayItBackCount = !input.unitsPersisted && includeSayItBack
    ? input.units.length
    : 0
  const exerciseCount = canonicalExerciseResult.totalCount + virtualSayItBackCount
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
  artifactWriteClient?: Client | null
  client: DbExecutor
  env?: Env | null
  hasActiveElevenLabsCredential?: ((communityId: string) => Promise<boolean>)
  post: StudyCapabilityPost
  targetLanguage?: string | null
  viewerUserId?: string | null
}): Promise<PostStudyCapability | null> {
  // Keep readiness semantics in parity with Telegram's batched picker query in
  // batchReadyPostIds (chat-study-service.ts); the cross-path matrix test guards both.
  if (input.post.post_type !== "song") return null
  const storedSourceLanguage = input.post.stored_source_language ?? input.post.source_language
  let post: StudyCapabilityPost = {
    ...input.post,
    source_language: resolveStoredSourceLanguage(storedSourceLanguage, [
      input.post.song_title,
      input.post.title,
      input.post.lyrics,
    ]),
    stored_source_language: storedSourceLanguage,
  }
  if (input.artifactWriteClient) {
    post = await repairStudyPostMetadata(input.artifactWriteClient, post)
  }
  let targetLanguage: string
  try {
    targetLanguage = normalizeStudyTargetLanguage(input.targetLanguage)
  } catch {
    return {
      source_language: post.source_language,
      status: "unavailable",
      target_language: null,
    }
  }
  const base = {
    source_language: post.source_language,
    target_language: targetLanguage,
  }

  if (!await canStudyCapabilityPost({
    client: input.client,
    post,
    viewerUserId: input.viewerUserId,
  })) {
    return {
      ...base,
      reasons: [{ code: "locked", kind: "entitlement", owner_action: "buy" }],
      status: "locked",
    }
  }

  const { persisted, units } = await resolveCapabilityStudyUnits({
    artifactWriteClient: input.artifactWriteClient,
    client: input.client,
    env: input.env,
    post,
    targetLanguage,
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
    post,
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

function toExercise(
  row: StudyExerciseRow,
  learnerSeed: string,
  progress: StudySessionExerciseProgress = {
    appearanceAttemptCount: 0,
    appearanceOrdinal: 0,
    firstOutcome: null,
    lastServedIndex: null,
    lessonResolved: false,
    mastered: false,
    presentationCount: 0,
  },
): SongStudyExercise {
  if (row.exercise_type === "translation_choice") {
    return {
      first_outcome: progress.firstOutcome,
      id: row.id,
      line_id: row.line_id,
      line_index: row.line_index,
      mastered: progress.mastered,
      max_attempts: STUDY_SESSION_MAX_CARD_PRESENTATIONS,
      options: orderOptionsForLearner(parseOptions(row.options_json), `${learnerSeed}:${row.id}`),
      presentation_count: progress.presentationCount,
      prompt_text: row.prompt_text,
      question: row.question || "Choose the best translation.",
      type: "translation_choice",
    }
  }
  return {
    first_outcome: progress.firstOutcome,
    id: row.id,
    line_id: row.line_id,
    line_index: row.line_index,
    mastered: progress.mastered,
    max_attempts: STUDY_SESSION_MAX_CARD_PRESENTATIONS,
    presentation_count: progress.presentationCount,
    prompt_text: row.prompt_text,
    reference_text: row.reference_text || row.prompt_text,
    translation_text: row.translation_text,
    type: "say_it_back",
  }
}

async function buildStudyLessonState(input: {
  client: ReadClient
  sessionId: string
  userId: string
}): Promise<SongStudyLessonState> {
  const state = await getStudyLessonTransitionState(input.client, input.sessionId)
  if (!state) throw new Error("Study session disappeared while projecting orchestration")
  return await renderStudyLessonState({ client: input.client, state, userId: input.userId })
}

async function renderStudyLessonState(input: {
  client: ReadClient
  state: import("./post-study-session-service").StudyLessonTransitionState
  userId: string
}): Promise<SongStudyLessonState> {
  const state = input.state
  const nextExercise = state.next
    ? await getExerciseForAttempt(input.client, state.next.exerciseId)
    : null
  return {
    completion_reason: state.completionReason,
    next: state.next && nextExercise ? {
      attempts_this_appearance: state.next.appearanceAttemptCount,
      exercise_id: state.next.exerciseId,
      is_reappearance: state.next.isReappearance,
      presentation_number: state.next.presentationNumber,
      prompt: toExercise(nextExercise, input.userId, {
        appearanceAttemptCount: state.next.appearanceAttemptCount,
        appearanceOrdinal: 0,
        firstOutcome: null,
        lastServedIndex: null,
        lessonResolved: false,
        mastered: false,
        presentationCount: state.next.presentationNumber - 1,
      }),
      retry_in_place: state.next.retryInPlace,
      type: nextExercise.exercise_type,
    } : null,
    resolved_count: state.resolvedCount,
    serving_index: state.servingIndex,
    session_revision: state.sessionRevision,
    total_count: state.totalCount,
  }
}

async function persistStudyRevisionConflictSnapshot(input: {
  client: Client
  exerciseId: string
  idempotencyKey: string
  now: string
  postId: string
  requestFingerprint: string
  sessionId: string
  userId: string
}): Promise<SongStudyLessonState> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await loadStudyTransitionSessionState({
      client: input.client,
      now: input.now,
      postId: input.postId,
      sessionId: input.sessionId,
      userId: input.userId,
    })
    const lesson = await buildStudyLessonState({
      client: input.client,
      sessionId: input.sessionId,
      userId: input.userId,
    })
    const snapshotExerciseId = state.exercises.find((candidate) => candidate.exerciseId === state.currentExerciseId)?.exerciseId
      ?? state.exercises.find((candidate) => candidate.exerciseId === input.exerciseId)?.exerciseId
      ?? state.exercises[0]?.exerciseId
    // A session can be retired between the stale pre-read and this persistence
    // step. With no surviving child row there is no FK-safe place to retain the
    // conflict snapshot; return the authoritative typed lesson deliberately.
    if (!snapshotExerciseId) return lesson
    const commitToken = makeId("src")
    await withTransaction(input.client, "write", async (tx) => {
      await tx.execute(buildStudyResponseSnapshotCasStatement({
        commitToken,
        exerciseId: snapshotExerciseId,
        expectedRevision: state.sessionRevision,
        httpStatus: 409,
        idempotencyKey: input.idempotencyKey,
        now: input.now,
        requestFingerprint: input.requestFingerprint,
        response: { lesson },
        resultKind: "revision_conflict",
        sessionId: input.sessionId,
        userId: input.userId,
      }))
    })
    const stored = await getStudyAttemptResponseSnapshot<{ lesson: SongStudyLessonState }>({
      client: input.client,
      idempotencyKey: input.idempotencyKey,
      userId: input.userId,
    })
    if (stored) {
      if (stored.requestFingerprint !== input.requestFingerprint) {
        throw conflictError("idempotency_key was reused with a different study attempt payload")
      }
      return stored.response.lesson
    }
  }
  throw conflictError("Study session changed while recording the revision conflict")
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
    let post = await getStudyPostById(db.client, input.postId)
    if (!post || post.community_id !== input.communityId) throw notFoundError("Post not found")
    if (!await canReadPostForStudy({ actor: input.actor, client: db.client, post })) {
      throw notFoundError("Post not found")
    }
    await requireAgeGateAccess({
      postAgeGatePolicy: post.age_gate_policy,
      userId: input.actor.userId,
      userRepository: getUserRepository(input.env),
    })
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

    post = await repairStudyPostMetadata(db.client, post)
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
    const translationStatus: SongStudyPayload["translation_status"] = !includeTranslation
      ? "not_applicable"
      : pack?.status === "ready"
        ? "ready"
        : pack?.status === "unavailable"
          ? "unavailable"
          : "processing"
    const now = nowIso()
    const reServeDueReviews = dueReviewServingEnabled(input.env)
    const canonicalExerciseRows = availability.canonicalExerciseRows
    const eligibleExerciseResult = await listExercises({
      client: db.client,
      dueReviewServing: reServeDueReviews,
      includeSayItBack,
      includeTranslation,
      now,
      postId: input.postId,
      targetLanguage,
      userId: input.actor.userId,
      limit: STUDY_SESSION_DISTINCT_EXERCISE_LIMIT,
    })
    const studySession = await ensureStudySession({
      available: canonicalExerciseRows,
      candidates: eligibleExerciseResult.rows,
      client: db.client,
      communityId: input.communityId,
      dueCount: eligibleExerciseResult.totalCount,
      now,
      postId: input.postId,
      targetLanguage,
      totalUnits: canonicalExerciseRows.length,
      userId: input.actor.userId,
    })
    const exercises = studySession.exercises.map(({ progress, row }) => toExercise(row, input.actor.userId, progress))
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
      ...studySession.summary,
      ...(nextDueAtSeconds ? { next_due_at: nextDueAtSeconds } : {}),
    }
    const lesson = session.id
      ? await buildStudyLessonState({ client: db.client, sessionId: session.id, userId: input.actor.userId })
      : undefined
    if (exercises.length === 0) {
      if (canonicalExerciseRows.length > 0) {
        return {
          ...basePayload({ access: "ready", post, targetLanguage }),
          generated_at: toUnixSeconds(pack?.generated_at ?? null),
          ...(lesson ? { lesson } : {}),
          session,
          source_language: pack?.source_language ?? post.source_language,
          study_pack_version: pack?.study_pack_version ?? STUDY_UNIT_GENERATION_VERSION,
          translation_status: translationStatus,
        }
      }
      if (availability.access === "processing") {
        return {
          ...basePayload({ access: "processing", post, targetLanguage }),
          source_language: pack?.source_language ?? post.source_language,
          translation_status: translationStatus,
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
      ...(lesson ? { lesson } : {}),
      session,
      source_language: pack?.source_language ?? post.source_language,
      study_pack_version: pack?.study_pack_version ?? STUDY_UNIT_GENERATION_VERSION,
      translation_status: translationStatus,
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
    let post = await getStudyPostById(db.client, postId)
    if (!post || post.community_id !== input.job.community_id || post.post_type !== "song") {
      return "skipped:missing_song"
    }
    await markStudyGenerationRunRunning({
      client: db.client,
      jobId: input.job.job_id,
      postId,
      targetLanguage,
      attemptCount: input.job.attempt_count,
    })
    if (!await isCommunityStudyEnabled({ executor: db.client, communityId: input.job.community_id })) {
      await completeStudyGenerationRun({
        client: db.client,
        postId,
        targetLanguage,
        status: "unavailable",
        errorCode: "study_disabled",
      })
      return "skipped:study_disabled"
    }
    post = await repairStudyPostMetadata(db.client, post)
    // A queued job for a same-language pair (e.g. enqueued before this guard existed)
    // must not generate degenerate same-language translation MCQs.
    if (isSameLanguageStudyPair(post.source_language, targetLanguage)) {
      await completeStudyGenerationRun({
        client: db.client,
        postId,
        targetLanguage,
        status: "unavailable",
        errorCode: "same_language",
      })
      return "skipped:same_language"
    }
    const units = await ensureStudyUnits(db.client, post)
    if (units.length === 0) {
      await completeStudyGenerationRun({
        client: db.client,
        postId,
        targetLanguage,
        status: "unavailable",
        errorCode: "no_lyrics",
      })
      return "skipped:no_lyrics"
    }
    if (await hasCompleteReadyStudyLocalizations({
      client: db.client,
      postId,
      targetLanguage,
    })) {
      await completeStudyGenerationRun({ client: db.client, postId, targetLanguage, status: "ready" })
      return "ready:already_generated"
    }
    if (!canGenerateStudyTranslations(input.env)) {
      await completeStudyGenerationRun({
        client: db.client,
        postId,
        targetLanguage,
        status: "unavailable",
        errorCode: "openrouter_unconfigured",
      })
      return "skipped:openrouter_unconfigured"
    }
    try {
      const pack = await createReadyStudyPack({
        client: db.client,
        env: input.env,
        post,
        targetLanguage,
      })
      const status = pack?.status === "ready" ? "ready" : "unavailable"
      await completeStudyGenerationRun({
        client: db.client,
        postId,
        targetLanguage,
        status,
        errorCode: status === "unavailable" ? "generation_failed" : null,
      })
      return pack?.job_result_ref ?? (status === "ready" ? `ready:${targetLanguage}` : "skipped:generation_unavailable")
    } catch (error) {
      await recordStudyGenerationRunFailure({
        client: db.client,
        errorCode: classifyStudyGenerationError(error),
        postId,
        targetLanguage,
        terminal: input.job.attempt_count >= COMMUNITY_JOB_MAX_ATTEMPTS,
      })
      throw error
    }
  } finally {
    await db.close()
  }
}

function resultFromAttempt(
  row: StudyAttemptRow,
  exercise: { correct_option_id: string | null; exercise_type: ExerciseType; max_attempts: number },
  lesson: SongStudyLessonState,
  session?: StudySessionSummary,
): SongStudyAttemptResult {
  const feedback = row.feedback_json ? JSON.parse(row.feedback_json) as SongStudyAttemptResult["feedback"] : undefined
  return {
    attempts_remaining: Math.max(0, STUDY_SESSION_MAX_CARD_PRESENTATIONS - row.attempt_number),
    ...(exercise.exercise_type === "translation_choice" && exercise.correct_option_id
      ? { correct_option_id: exercise.correct_option_id }
      : {}),
    exercise_id: row.exercise_id,
    ...(feedback ? { feedback } : {}),
    ...(row.fsrs_rating ? { next_review_hint: row.fsrs_rating } : {}),
    lesson,
    object: "song_study_attempt_result",
    outcome: row.outcome,
    ...(session ? { session } : {}),
  }
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
    && input.existing.study_session_id === readString(input.body.session_id)
    && input.existing.selected_option_id === selectedOptionId
    && input.existing.transcript === transcript
  if (!same) {
    throw conflictError("idempotency_key was reused with a different study attempt payload")
  }
}

type StudyEngagementProgress = {
  qualifiedToday: boolean
  studyAttemptCount: number
  studyCorrectCount: number
  studyTargetCount: number
}

function previousDateString(date: string): string {
  const ms = Date.parse(`${date}T00:00:00.000Z`)
  if (!Number.isFinite(ms)) return date
  return new Date(ms - 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

function projectStudyStreakCount(input: {
  engagement: StudyEngagementProgress
  now: string
  streakRow: Record<string, unknown> | null
  studyTimezone?: string
}): number {
  const current = Number(input.streakRow?.current_streak ?? 0)
  const activeUntilAt = readString(input.streakRow?.active_until_at)
  const alive = Boolean(activeUntilAt && activeUntilAt > input.now)
  if (!input.engagement.qualifiedToday) {
    // Lapsed streaks project 0: the stored count is historical (best_streak
    // carries the record). Same read-time projection as the viewer standing.
    return alive ? current : 0
  }
  const timezone = readString(input.streakRow?.timezone) ?? input.studyTimezone ?? STUDY_FALLBACK_TIMEZONE
  const today = studyActivityDate(input.now, timezone)
  const lastQualifiedDate = readString(input.streakRow?.last_qualified_date)
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
  const streakRow = await executeFirst(input.client, {
    sql: `
      SELECT current_streak, last_qualified_date, active_until_at, timezone
      FROM song_streaks
      WHERE user_id = ?1
        AND post_id = ?2
    `,
    args: [input.userId, input.postId],
  }) as Record<string, unknown> | null
  const timezone = readString(streakRow?.timezone) ?? input.studyTimezone ?? STUDY_FALLBACK_TIMEZONE
  const today = studyActivityDate(input.now, timezone)
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
  const currentStreak = projectStudyStreakCount({
    engagement,
    now: input.now,
    streakRow,
    studyTimezone: input.studyTimezone,
  })
  const nextDueAt = await getNextDueAt({
    client: input.client,
    includeSayItBack: input.includeSayItBack,
    includeTranslation: input.includeTranslation,
    now: input.now,
    postId: input.postId,
    targetLanguage: input.targetLanguage,
    userId: input.userId,
  })
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

export async function submitPostStudyAttempt(input: {
  actor: ActorContext | AdminActorContext
  body: SongStudyAttemptRequest
  communityId: string
  communityRepository: CommunityDatabaseBindingRepository
  defer?: (task: Promise<unknown>) => void
  env: Env
  postId: string
  studyTimezone?: string
}): Promise<SongStudyAttemptResult> {
  const idempotencyKey = readRequiredString(input.body.idempotency_key, "idempotency_key")
  const sessionId = readRequiredString(input.body.session_id, "session_id")
  const exerciseId = readRequiredString(input.body.exercise_id, "exercise_id")
  const type = readRequiredString(input.body.type, "type") as ExerciseType
  if (type !== "say_it_back" && type !== "translation_choice") {
    throw badRequestError("type must be say_it_back or translation_choice")
  }
  const attemptNumber = readAttemptNumber(input.body.attempt_number)
  const sessionRevision = readOptionalSessionRevision(input.body.session_revision)
  const transcriptionLanguageCode = readOptionalTranscriptionLanguageCode(input.body.transcription_language_code)
  const transcriptionLanguageProbability = readOptionalTranscriptionLanguageProbability(
    input.body.transcription_language_probability,
  )
  if (type !== "say_it_back" && (transcriptionLanguageCode || transcriptionLanguageProbability != null)) {
    throw badRequestError("transcription language metadata is only valid for say_it_back")
  }
  const requestFingerprint = studyAttemptRequestFingerprint({
    attemptNumber,
    exerciseId,
    selectedOptionId: readString(input.body.selected_option_id),
    sessionId,
    sessionRevision: sessionRevision ?? null,
    transcript: readString(input.body.transcript),
    transcriptionLanguageCode,
    transcriptionLanguageProbability,
    type,
  })
  // The streak day boundary belongs to the learner: prefer the device's IANA
  // timezone from the client; fall back to the edge-derived one from the route.
  const requestTimezone = readString(input.body.timezone)
  const timezoneCandidate = isValidIanaTimezone(requestTimezone) ? requestTimezone : input.studyTimezone

  const timingEnabled = studyAttemptTimingLogsEnabled(input.env)
  const timingStartedAt = performance.now()
  let openClientMs: number | undefined
  let parallelReadBatchMs: number | undefined
  let accessReadBatchMs: number | undefined
  let writeTxMs: number | undefined
  let closeClientMs: number | undefined
  let timingOutcome = "error"
  let timingExerciseType: ExerciseType | undefined
  let timingStreakWritesEnabled = false
  let resultForTiming: SongStudyAttemptResult | undefined
  const openClientStartedAt = performance.now()
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  openClientMs = elapsedMs(openClientStartedAt)
  try {
    const communityStudyEnabled = await isCommunityStudyEnabled({ executor: db.client, communityId: input.communityId })
    if (!communityStudyEnabled) {
      throw new HttpError(403, "forbidden", "Study is disabled for this community")
    }
    const streakWritesEnabled = studyStreakWritesEnabled(input.env)
    const rewardQualificationWritesEnabled = envFlag(input.env.REWARDS_CAMPAIGNS_ENABLED, false)
      && envFlag(input.env.REWARDS_ACCRUAL_ENABLED, false)
    timingStreakWritesEnabled = streakWritesEnabled
    const persistCompletedSession = async (
      summary: StudySessionSummary,
      materialization?: { completed_at: string; study_timezone: string | null },
    ) => {
      if (summary.status !== "completed" || !summary.id) return
      const completedAt = materialization?.completed_at ?? nowIso()
      const completedSessionId = summary.id
      const frozenTimezone = materialization?.study_timezone ?? timezoneCandidate
      // Pin/expiry resolution reads existing streak state, so it runs BEFORE
      // the write tx (buffered D1 txs cannot read). The tx itself is then pure
      // writes: day upsert + streak materialization + column apply, committed
      // atomically — a leaderboard read right after the response is consistent.
      // Pin establishment is a compare-and-swap that must COMMIT before the
      // preparation read, so a concurrent first qualifier (e.g. a karaoke take
      // landing at the same moment with a different device timezone) cannot
      // make this session prepare dates/expiry under a losing timezone.
      if (streakWritesEnabled && summary.qualified) {
        await claimStreakTimezonePin({
          client: db.client,
          communityId: input.communityId,
          now: completedAt,
          postId: input.postId,
          timezoneCandidate: frozenTimezone,
          userId: input.actor.userId,
        })
      }
      const preparation = streakWritesEnabled
        ? await prepareStreakWrite({
          activityInstant: completedAt,
          client: db.client,
          now: completedAt,
          postId: input.postId,
          qualified: summary.qualified,
          timezoneCandidate: frozenTimezone,
          userId: input.actor.userId,
        })
        : null
      let rewardQualification: Awaited<ReturnType<typeof emitStudyQualificationIfComplete>> = null
      await withTransaction(db.client, "write", async (tx) => {
        if (streakWritesEnabled && preparation) {
          await recordCompletedSessionStreak({
            client: tx,
            communityId: input.communityId,
            completedExerciseCount: summary.completed_exercise_count,
            firstPassCorrectCount: summary.first_pass_correct_count,
            now: completedAt,
            postId: input.postId,
            preparation,
            qualified: summary.qualified,
            requiredCorrectCount: summary.required_correct_count,
            userId: input.actor.userId,
          })
        }
        if (rewardQualificationWritesEnabled && summary.qualified) {
          rewardQualification = await emitStudyQualificationIfComplete({
            client: tx,
            communityId: input.communityId,
            completedExerciseCount: summary.completed_exercise_count,
            firstPassCorrectCount: summary.first_pass_correct_count,
            now: completedAt,
            postId: input.postId,
            requiredCorrectCount: summary.required_correct_count,
            sessionId: completedSessionId,
            userId: input.actor.userId,
          })
        }
      })
      if (rewardQualification) {
        deferRewardQualificationWakeup({
          defer: input.defer,
          env: input.env,
          event: rewardQualification,
        })
      }
    }

    const finalizeResponse = async (
      snapshot: Awaited<ReturnType<typeof getStudyAttemptResponseSnapshot<SongStudyAttemptResult>>>,
    ): Promise<SongStudyAttemptResult> => {
      if (!snapshot) throw new Error("Study response snapshot disappeared")
      if (snapshot.requestFingerprint !== requestFingerprint) {
        throw conflictError("idempotency_key was reused with a different study attempt payload")
      }
      if (snapshot.responseStatus === "final") return snapshot.response
      const summary = snapshot.response.session
      if (!summary || summary.status !== "completed") {
        throw new Error("Only a completed graded response may remain pending")
      }
      await persistCompletedSession(summary, snapshot.materializationContext ?? undefined)
      let finalResponse = snapshot.response
      if (streakWritesEnabled) {
        const responsePost = await getStudyPostById(db.client, input.postId)
        if (!responsePost) throw notFoundError("Post not found")
        const finalizedSessionState = await loadStudyTransitionSessionState({
          client: db.client,
          now: snapshot.materializationContext?.completed_at ?? nowIso(),
          postId: input.postId,
          sessionId,
          userId: input.actor.userId,
        })
        const progress = await getStudyAttemptProgressSnapshot({
          client: db.client,
          includeSayItBack: true,
          includeTranslation: !isSameLanguageStudyPair(responsePost.source_language, finalizedSessionState.targetLanguage),
          now: snapshot.materializationContext?.completed_at ?? nowIso(),
          postId: input.postId,
          targetLanguage: finalizedSessionState.targetLanguage,
          studyTimezone: snapshot.materializationContext?.study_timezone ?? input.studyTimezone,
          userId: input.actor.userId,
        })
        finalResponse = { ...snapshot.response, ...(progress ? { study_progress: progress } : {}) }
      }
      await finalizeStudyAttemptResponseSnapshot({
        client: db.client,
        idempotencyKey,
        response: finalResponse,
        userId: input.actor.userId,
      })
      const winner = await getStudyAttemptResponseSnapshot<SongStudyAttemptResult>({
        client: db.client,
        idempotencyKey,
        userId: input.actor.userId,
      })
      if (!winner || winner.responseStatus !== "final") {
        throw new Error("Study response snapshot did not finalize")
      }
      return winner.response
    }

    const storedResponse = await getStudyAttemptResponseSnapshot<SongStudyAttemptResult | { lesson: SongStudyLessonState }>({
      client: db.client,
      idempotencyKey,
      userId: input.actor.userId,
    })
    if (storedResponse) {
      if (storedResponse.requestFingerprint !== requestFingerprint) {
        throw conflictError("idempotency_key was reused with a different study attempt payload")
      }
      timingOutcome = "idempotent_retry"
      if (storedResponse.httpStatus === 409) {
        const lesson = storedResponse.response.lesson
        throw codedConflictError(
          "study_session_revision_conflict",
          "Study session orchestration has advanced",
          { lesson },
        )
      }
      resultForTiming = await finalizeResponse(storedResponse as Awaited<ReturnType<
        typeof getStudyAttemptResponseSnapshot<SongStudyAttemptResult>
      >>)
      return resultForTiming
    }

    const existing = await getAttemptByIdempotencyKey(db.client, input.actor.userId, idempotencyKey)
    const existingExercise = existing ? await getExerciseForAttempt(db.client, existing.exercise_id) : null
    if (existing && existingExercise) {
      const exactSnapshot = await getStudyAttemptResponseSnapshot<SongStudyAttemptResult>({
        client: db.client,
        idempotencyKey,
        userId: input.actor.userId,
      })
      if (exactSnapshot) {
        if (exactSnapshot.requestFingerprint !== requestFingerprint) {
          throw conflictError("idempotency_key was reused with a different study attempt payload")
        }
        resultForTiming = await finalizeResponse(exactSnapshot)
        return resultForTiming
      }
      assertEquivalentIdempotentRetry({
        attemptNumber,
        body: input.body,
        existing,
        exerciseId,
        type,
      })
      timingOutcome = "idempotent_retry"
      timingExerciseType = existingExercise.exercise_type
      const retrySession = existing.study_session_id
        ? await getStudySessionSummary(db.client, existing.study_session_id)
        : undefined
      if (retrySession) await persistCompletedSession(retrySession)
      if (!existing.study_session_id) throw conflictError("Legacy study attempt has no session orchestration")
      const retryLesson = await buildStudyLessonState({
        client: db.client,
        sessionId: existing.study_session_id,
        userId: input.actor.userId,
      })
      resultForTiming = resultFromAttempt(existing, existingExercise, retryLesson, retrySession)
      return resultForTiming
    }

    const existingPresentation = await getAttemptBySessionPresentation({
      attemptNumber,
      client: db.client,
      exerciseId,
      sessionId,
      userId: input.actor.userId,
    })
    const existingPresentationExercise = existingPresentation
      ? await getExerciseForAttempt(db.client, existingPresentation.exercise_id)
      : null
    if (existingPresentation && existingPresentationExercise) {
      const exactSnapshot = await getStudyAttemptResponseSnapshot<SongStudyAttemptResult>({
        client: db.client,
        idempotencyKey,
        userId: input.actor.userId,
      })
      if (exactSnapshot) {
        if (exactSnapshot.requestFingerprint !== requestFingerprint) {
          throw conflictError("idempotency_key was reused with a different study attempt payload")
        }
        resultForTiming = await finalizeResponse(exactSnapshot)
        return resultForTiming
      }
      if (sessionRevision != null) {
        const lesson = await persistStudyRevisionConflictSnapshot({
          client: db.client,
          exerciseId,
          idempotencyKey,
          now: nowIso(),
          postId: input.postId,
          requestFingerprint,
          sessionId,
          userId: input.actor.userId,
        })
        throw codedConflictError(
          "study_session_revision_conflict",
          "Study session orchestration has advanced",
          { lesson },
        )
      }
      assertEquivalentIdempotentRetry({
        attemptNumber,
        body: input.body,
        existing: existingPresentation,
        exerciseId,
        type,
      })
      timingOutcome = "logical_retry"
      timingExerciseType = existingPresentationExercise.exercise_type
      const retrySession = await getStudySessionSummary(db.client, sessionId)
      if (retrySession) await persistCompletedSession(retrySession)
      const retryLesson = await buildStudyLessonState({ client: db.client, sessionId, userId: input.actor.userId })
      resultForTiming = resultFromAttempt(
        existingPresentation,
        existingPresentationExercise,
        retryLesson,
        retrySession,
      )
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
    if (sessionRevision != null) {
      const authoritative = await loadStudyTransitionSessionState({
        client: db.client,
        now,
        postId: input.postId,
        sessionId,
        userId: input.actor.userId,
      })
      if (hasStudyRevisionConflict({ exerciseId, expectedRevision: sessionRevision, session: authoritative })) {
        const lesson = await persistStudyRevisionConflictSnapshot({
          client: db.client,
          exerciseId,
          idempotencyKey,
          now,
          postId: input.postId,
          requestFingerprint,
          sessionId,
          userId: input.actor.userId,
        })
        throw codedConflictError(
          "study_session_revision_conflict",
          "Study session orchestration has advanced",
          { lesson },
        )
      }
    }
    await requireStudySessionForAttempt({
      attemptNumber,
      client: db.client,
      exerciseId,
      now,
      postId: input.postId,
      sessionId,
      userId: input.actor.userId,
    })
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

    if (!post || post.community_id !== input.communityId) throw notFoundError("Post not found")
    // A session created before metadata healing may still carry an exercise id
    // with the old language suffix. Grade and validate speech against the post's
    // resolved language so that active sessions recover immediately too.
    const sourceLanguage = post.source_language ?? exercise.source_language
    const transcriptionLanguageMismatch = type === "say_it_back"
      && isClearSpeechLanguageMismatch({
        detectedLanguage: transcriptionLanguageCode,
        expectedLanguage: sourceLanguage,
        probability: transcriptionLanguageProbability,
      })
    const accessReadBatchStartedAt = performance.now()
    const [canReadPost, canStudy] = await Promise.all([
      canReadPostForStudy({ actor: input.actor, client: db.client, post }),
      canStudyPost({ actor: input.actor, client: db.client, communityId: input.communityId, post }),
    ])
    accessReadBatchMs = elapsedMs(accessReadBatchStartedAt)
    if (!canReadPost) {
      throw notFoundError("Post not found")
    }
    await requireAgeGateAccess({
      postAgeGatePolicy: post.age_gate_policy,
      userId: input.actor.userId,
      userRepository: getUserRepository(input.env),
    })
    if (!canStudy) {
      throw new HttpError(403, "forbidden", "Caller is not entitled to study this post")
    }
    let correct = false
    let selectedOptionId: string | null = null
    let transcript: string | null = null
    let feedback: SongStudyAttemptResult["feedback"] | undefined
    let rating: FsrsRating | null = null
    let voiceOverlap = 1
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
        sourceLanguage,
        transcript,
      })
      correct = grade.correct
      feedback = grade.feedback
      rating = grade.rating
      voiceOverlap = grade.overlap
    }
    const outcome: AttemptOutcome = correct
      ? "correct"
      : attemptNumber >= STUDY_SESSION_MAX_CARD_PRESENTATIONS ? "revealed" : "incorrect"
    rating ??= fsrsRatingFor(outcome, attemptNumber)
    const attemptsRemaining = Math.max(0, STUDY_SESSION_MAX_CARD_PRESENTATIONS - attemptNumber)
    const writeTxStartedAt = performance.now()
    const attemptId = makeId("sta")
    let committed: { result: SongStudyAttemptResult; session: StudySessionSummary } | null = null
    for (let casAttempt = 0; casAttempt < 3 && !committed; casAttempt += 1) {
      const state = await loadStudyTransitionSessionState({
        client: db.client,
        now,
        postId: input.postId,
        sessionId,
        userId: input.actor.userId,
      })
      if (sessionRevision != null && hasStudyRevisionConflict({
        exerciseId,
        expectedRevision: sessionRevision,
        session: state,
      })) {
        const lesson = await persistStudyRevisionConflictSnapshot({
          client: db.client,
          exerciseId,
          idempotencyKey,
          now,
          postId: input.postId,
          requestFingerprint,
          sessionId,
          userId: input.actor.userId,
        })
        throw codedConflictError(
          "study_session_revision_conflict",
          "Study session orchestration has advanced",
          { lesson },
        )
      }
      const stateExercise = state.exercises.find((candidate) => candidate.exerciseId === exerciseId)
      if (!stateExercise) throw notFoundError("Study session exercise not found")
      const useUngradable = type === "say_it_back"
        && ungradableRerecordEnabled(input.env)
        && (transcriptionLanguageMismatch || (!correct && voiceOverlap < 1 / 3))
        && !await hasUngradableReceipt({
          appearanceOrdinal: stateExercise.appearanceOrdinal,
          client: db.client,
          exerciseId,
          sessionId,
        })
      const plan = useUngradable
        ? planUngradableStudyTransition({ exerciseId, session: state })
        : planGradedStudyTransition({ attemptNumber, exerciseId, exerciseType: type, outcome, session: state })
      const lesson = await renderStudyLessonState({ client: db.client, state: plan.lesson, userId: input.actor.userId })
      const result: SongStudyAttemptResult = {
        attempts_remaining: useUngradable
          ? Math.max(0, STUDY_SESSION_MAX_CARD_PRESENTATIONS - stateExercise.presentationCount)
          : attemptsRemaining,
        ...(!useUngradable && type === "translation_choice" && exercise.correct_option_id
          ? { correct_option_id: exercise.correct_option_id }
          : {}),
        exercise_id: exercise.id,
        ...(feedback ? { feedback } : {}),
        lesson,
        ...(!useUngradable ? { next_review_hint: rating ?? undefined } : {}),
        object: "song_study_attempt_result",
        outcome: useUngradable ? "ungradable" : outcome,
        session: plan.session,
      }
      const commitToken = makeId("src")
      try {
        await withTransaction(db.client, "write", async (tx) => {
        await tx.execute(buildStudyResponseSnapshotCasStatement({
          commitToken,
          exerciseId,
          expectedRevision: state.sessionRevision,
          idempotencyKey,
          materializationContext: !useUngradable && plan.session.status === "completed"
            ? { completed_at: now, study_timezone: timezoneCandidate ?? null }
            : null,
          now,
          requestFingerprint,
          response: result,
          responseStatus: !useUngradable && plan.session.status === "completed" ? "pending" : "final",
          resultKind: useUngradable ? "ungradable" : "graded",
          sessionId,
          userId: input.actor.userId,
        }))
        if (useUngradable) {
          await recordOwnedUngradableReceipt({
            appearanceOrdinal: stateExercise.appearanceOrdinal,
            client: tx,
            commitToken,
            exerciseId,
            idempotencyKey,
            now,
            sessionId,
            userId: input.actor.userId,
          })
        } else {
          await tx.execute({
        sql: `
          INSERT INTO song_study_attempt (
            id, user_id, post_id, exercise_id, line_id, exercise_type,
            target_language, study_pack_version, attempt_number, idempotency_key,
            selected_option_id, transcript, outcome, feedback_json, fsrs_rating, created_at,
            study_session_id, presentation_number
          )
          SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?9
          WHERE EXISTS (
            SELECT 1 FROM song_study_attempt_response r
            WHERE r.user_id = ?2 AND r.idempotency_key = ?10 AND r.commit_token = ?18
          )
        `,
        args: [
          attemptId,
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
          rating,
          now,
          sessionId,
          commitToken,
        ],
      })
          await upsertReviewState({
        attemptId,
        client: tx,
        existing: existingReviewState,
        exercise,
        now,
        rating,
        userId: input.actor.userId,
      })
        }
        await applyPlannedStudyTransition({
          client: tx,
          commitToken,
          expectedRevision: state.sessionRevision,
          idempotencyKey,
          now,
          plan,
          sessionId,
          userId: input.actor.userId,
        })
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const legacyPresentationRace = sessionRevision == null
          && /(?:UNIQUE constraint failed|constraint failed).*song_study_attempt/iu.test(message)
        if (!legacyPresentationRace) throw error
      }
      const stored = await getStudyAttemptResponseSnapshot<SongStudyAttemptResult>({
        client: db.client,
        idempotencyKey,
        userId: input.actor.userId,
      })
      if (stored) {
        if (stored.requestFingerprint !== requestFingerprint) {
          throw conflictError("idempotency_key was reused with a different study attempt payload")
        }
        if (stored.httpStatus === 409) {
          throw codedConflictError(
            "study_session_revision_conflict",
            "Study session orchestration has advanced",
            { lesson: (stored.response as unknown as { lesson: SongStudyLessonState }).lesson },
          )
        }
        const finalized = await finalizeResponse(stored)
        committed = { result: finalized, session: finalized.session ?? plan.session }
      } else if (sessionRevision != null) {
        const conflictLesson = await persistStudyRevisionConflictSnapshot({
          client: db.client,
          exerciseId,
          idempotencyKey,
          now,
          postId: input.postId,
          requestFingerprint,
          sessionId,
          userId: input.actor.userId,
        })
        throw codedConflictError(
          "study_session_revision_conflict",
          "Study session orchestration has advanced",
          { lesson: conflictLesson },
        )
      } else {
        // A deployed revision-absent client may race another harmless retry of
        // the same logical presentation under a different key. The unique
        // presentation row is the durable winner; replay it without touching
        // FSRS, counters, rewards, or the orchestration revision again.
        const logicalWinner = await getAttemptBySessionPresentation({
          attemptNumber,
          client: db.client,
          exerciseId,
          sessionId,
          userId: input.actor.userId,
        })
        if (logicalWinner) {
          assertEquivalentIdempotentRetry({
            attemptNumber,
            body: input.body,
            existing: logicalWinner,
            exerciseId,
            type,
          })
          const retrySession = await getStudySessionSummary(db.client, sessionId)
          if (!retrySession) throw notFoundError("Study session not found")
          await persistCompletedSession(retrySession)
          const retryLesson = await buildStudyLessonState({
            client: db.client,
            sessionId,
            userId: input.actor.userId,
          })
          committed = {
            result: resultFromAttempt(logicalWinner, exercise, retryLesson, retrySession),
            session: retrySession,
          }
        }
      }
    }
    if (!committed) throw conflictError("Study session changed while recording the attempt")
    resultForTiming = committed.result

    if (resultForTiming.outcome === "ungradable") {
      timingOutcome = "ungradable"
      writeTxMs = elapsedMs(writeTxStartedAt)
      return resultForTiming
    }
    const storedAttempt = await getAttemptBySessionPresentation({
      attemptNumber,
      client: db.client,
      exerciseId,
      sessionId,
      userId: input.actor.userId,
    })
    if (!storedAttempt) throw conflictError("Study presentation has already been recorded")
    writeTxMs = elapsedMs(writeTxStartedAt)
    timingOutcome = outcome
    return resultForTiming
  } finally {
    const closeClientStartedAt = performance.now()
    await db.close()
    closeClientMs = elapsedMs(closeClientStartedAt)
    if (timingEnabled) {
      const timing: SongStudyAttemptTiming = {
        access_read_batch_ms: accessReadBatchMs,
        close_client_ms: closeClientMs,
        community_id: input.communityId,
        exercise_id: exerciseId,
        exercise_type: timingExerciseType,
        open_client_ms: openClientMs,
        outcome: timingOutcome,
        parallel_read_batch_ms: parallelReadBatchMs,
        post_id: input.postId,
        streak_writes_enabled: timingStreakWritesEnabled,
        total_ms: elapsedMs(timingStartedAt),
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
  // Shards not yet migrated to the streak template (1119) or the owner-timezone
  // template (1149) degrade to "no streak data" instead of failing the read.
  return /no such table:\s*(song_streaks|song_engagement_days)/iu.test(message)
    || /no such column:\s*(timezone|timezone_updated_at|active_until_at)/iu.test(message)
}

export async function getPostStreakSummary(input: {
  client: Client
  postId: string
  profileRepository: ProfileRepository
  userRepository: UserRepository
  userId: string | null
}): Promise<SongStreakSummary | null> {
  if (!input.userId) return null
  const post = await getStudyPostById(input.client, input.postId)
  if (!post || post.post_type !== "song" || post.status !== "published") return null
  if (post.access_mode === "locked") {
    try {
      await requireMemberAccess(input.client, post.community_id, input.userId)
    } catch (error) {
      if (isMissingStreakTableError(error)) return null
      if (error instanceof HttpError && error.status === 404) return null
      throw error
    }
  }
  await requireAgeGateAccess({
    postAgeGatePolicy: post.age_gate_policy,
    userId: input.userId,
    userRepository: input.userRepository,
  })
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
    await requireAgeGateAccess({
      postAgeGatePolicy: post.age_gate_policy,
      userId: input.actor.userId,
      userRepository: getUserRepository(input.env),
    })

    let date: string
    let summary: SongStreakSummary
    try {
      ;({ date, summary } = await readSongStreakSummary({
        client: db.client as Client,
        limit,
        postId: input.postId,
        profileRepository: input.profileRepository,
        userId: input.actor.userId,
      }))
    } catch (error) {
      if (!isMissingStreakTableError(error)) throw error
      // Shard not yet migrated to the streak templates: serve an empty board.
      date = studyActivityDate(nowIso(), STUDY_FALLBACK_TIMEZONE)
      summary = { entries: [], total_active_streaks: 0, viewer: null }
    }

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
  let sourceLanguage: string | null = null
  try {
    if (!await isCommunityStudyEnabled({ executor: db.client, communityId: input.communityId })) {
      throw new HttpError(403, "forbidden", "Study is disabled for this community")
    }

    const post = await getStudyPostById(db.client, input.postId)
    if (!post || post.community_id !== input.communityId) throw notFoundError("Post not found")
    if (!await canReadPostForStudy({ actor: input.actor, client: db.client, post })) {
      throw notFoundError("Post not found")
    }
    await requireAgeGateAccess({
      postAgeGatePolicy: post.age_gate_policy,
      userId: input.actor.userId,
      userRepository: getUserRepository(input.env),
    })
    if (post.post_type !== "song") {
      throw notFoundError("Study is not available")
    }
    sourceLanguage = normalizeSpeechLanguageCode(post.source_language)
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
    languageCode: sourceLanguage,
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
