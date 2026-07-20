import type { ActorContext, AdminActorContext } from "../auth-middleware"
import type { Env } from "../../env"
import type { SongFeatureCapabilityReason } from "../../types"
import type { ProfileRepository } from "../auth/repositories"
import { badRequestError, conflictError, HttpError, notFoundError } from "../errors"
import { executeFirst, type DbExecutor } from "../db-helpers"
import { envFlag, makeId, nowIso } from "../helpers"
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
import { transcribeCommunityAudioWithElevenLabs } from "../communities/assistant-policy/speech-service"
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
import { canReadPostForStudy, canStudyPost, getStudyPostById, type StudyPost } from "./post-study-access"
import { getNextDueAt, listExercises } from "./post-study-exercise-query"
import {
  ensureStudySession,
  getStudySessionSummary,
  recordStudySessionPresentation,
  requireStudySessionForAttempt,
  STUDY_SESSION_DISTINCT_EXERCISE_LIMIT,
  STUDY_SESSION_MAX_CARD_PRESENTATIONS,
  type StudySessionExerciseProgress,
  type StudySessionSummary,
} from "./post-study-session-service"
import { canGenerateStudyTranslations } from "./post-study-generation-provider"
import { requireMemberAccess } from "./post-access"
import { publicCommunityId, publicPostId } from "../public-ids"
import { withTransaction } from "../transactions"
import { emitStudyQualificationIfComplete } from "../rewards/reward-qualification-outbox"
import { fsrsRatingFor, gradeSayItBack, type AttemptOutcome, type FsrsRating } from "./post-study-recall-grading"
import {
  ensureStudyUnits,
  selectStudyUnits,
  splitLyricsForStudy,
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
  studyActivityDate,
  STUDY_FALLBACK_TIMEZONE,
  type SongStreakLeaderboardEntry,
  type SongStreakSummary,
  type SongStreakViewerStanding,
} from "./post-study-streak-read-service"
import {
  recordStudyStreakMaterialization,
  upsertCompletedStudySessionDay,
} from "./post-study-streak-write-service"

export { listPostStreakSummaries } from "./post-study-streak-read-service"
export type { SongStreakSummary } from "./post-study-streak-read-service"
export { upsertStudyStreakProgress } from "./post-study-streak-write-service"

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
  session_id?: unknown
  selected_option_id?: unknown
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
  session?: SongStudySessionSummary
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
  streak_deferred: boolean
  streak_inline_ms?: number
  streak_target_count_ms?: number
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

function toExercise(
  row: StudyExerciseRow,
  learnerSeed: string,
  progress: StudySessionExerciseProgress = { firstOutcome: null, mastered: false, presentationCount: 0 },
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
  const sessionId = readRequiredString(input.body.session_id, "session_id")
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
    const streakWritesEnabled = studyStreakWritesEnabled(input.env)
    const rewardQualificationWritesEnabled = envFlag(input.env.REWARDS_CAMPAIGNS_ENABLED, false)
      && envFlag(input.env.REWARDS_ACCRUAL_ENABLED, false)
    timingStreakWritesEnabled = streakWritesEnabled
    const persistCompletedSession = async (summary: StudySessionSummary) => {
      if (summary.status !== "completed" || !summary.id) return
      const completedAt = nowIso()
      const completedSessionId = summary.id
      await withTransaction(db.client, "write", async (tx) => {
        if (streakWritesEnabled) {
          await upsertCompletedStudySessionDay({
            client: tx,
            communityId: input.communityId,
            completedExerciseCount: summary.completed_exercise_count,
            firstPassCorrectCount: summary.first_pass_correct_count,
            now: completedAt,
            postId: input.postId,
            qualified: summary.qualified,
            requiredCorrectCount: summary.required_correct_count,
            studyTimezone: input.studyTimezone,
            userId: input.actor.userId,
          })
        }
        if (rewardQualificationWritesEnabled && summary.qualified) {
          await emitStudyQualificationIfComplete({
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
      if (!streakWritesEnabled) return
      const recordStreak = async () => {
        await input.testHooks?.beforeDeferredStreakMaterialization?.()
        await recordStudyStreakMaterialization({
          communityId: input.communityId,
          communityRepository: input.communityRepository,
          env: input.env,
          now: completedAt,
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
      const retrySession = existing.study_session_id
        ? await getStudySessionSummary(db.client, existing.study_session_id)
        : undefined
      if (retrySession) await persistCompletedSession(retrySession)
      resultForTiming = resultFromAttempt(existing, existingExercise, retrySession)
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
      resultForTiming = resultFromAttempt(
        existingPresentation,
        existingPresentationExercise,
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
    const studySession = await requireStudySessionForAttempt({
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
      : attemptNumber >= STUDY_SESSION_MAX_CARD_PRESENTATIONS ? "revealed" : "incorrect"
    rating ??= fsrsRatingFor(outcome, attemptNumber)
    const attemptsRemaining = Math.max(0, STUDY_SESSION_MAX_CARD_PRESENTATIONS - attemptNumber)
    const writeTxStartedAt = performance.now()
    const attemptId = makeId("sta")
    await withTransaction(db.client, "write", async (tx) => {
      await tx.execute({
        sql: `
          INSERT INTO song_study_attempt (
            id, user_id, post_id, exercise_id, line_id, exercise_type,
            target_language, study_pack_version, attempt_number, idempotency_key,
            selected_option_id, transcript, outcome, feedback_json, fsrs_rating, created_at,
            study_session_id, presentation_number
          )
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?9)
          ON CONFLICT DO NOTHING
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
      await recordStudySessionPresentation({
        attemptId,
        client: tx,
        exerciseId,
        now,
        outcome,
        sessionId,
      })
    })
    const storedAttempt = await getAttemptBySessionPresentation({
      attemptNumber,
      client: db.client,
      exerciseId,
      sessionId,
      userId: input.actor.userId,
    })
    if (!storedAttempt) throw conflictError("Study presentation has already been recorded")
    if (storedAttempt.id !== attemptId) {
      assertEquivalentIdempotentRetry({ attemptNumber, body: input.body, existing: storedAttempt, exerciseId, type })
      timingOutcome = "logical_retry"
      const retrySession = await getStudySessionSummary(db.client, sessionId)
      if (retrySession) await persistCompletedSession(retrySession)
      resultForTiming = resultFromAttempt(
        storedAttempt,
        exercise,
        retrySession,
      )
      return resultForTiming
    }
    const sessionSummary = await getStudySessionSummary(db.client, sessionId)
    if (!sessionSummary) throw new Error("Study session disappeared after recording progress")
    await persistCompletedSession(sessionSummary)
    const fsrsRating = rating
    writeTxMs = elapsedMs(writeTxStartedAt)
    if (streakWritesEnabled && sessionSummary.status === "completed") {
      studyProgress = await getStudyAttemptProgressSnapshot({
        client: db.client,
        includeSayItBack: true,
        includeTranslation: !isSameLanguageStudyPair(post.source_language, studySession.targetLanguage),
        now,
        postId: input.postId,
        targetLanguage: studySession.targetLanguage,
        studyTimezone: input.studyTimezone,
        userId: input.actor.userId,
      })
    }
    timingOutcome = outcome
    resultForTiming = {
      attempts_remaining: attemptsRemaining,
      ...(type === "translation_choice" && exercise.correct_option_id
        ? { correct_option_id: exercise.correct_option_id }
        : {}),
      exercise_id: exercise.id,
      ...(feedback ? { feedback } : {}),
      next_review_hint: fsrsRating,
      object: "song_study_attempt_result",
      outcome,
      session: sessionSummary,
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
        community_id: input.communityId,
        exercise_id: exerciseId,
        exercise_type: timingExerciseType,
        open_client_ms: openClientMs,
        outcome: timingOutcome,
        parallel_read_batch_ms: parallelReadBatchMs,
        post_id: input.postId,
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
