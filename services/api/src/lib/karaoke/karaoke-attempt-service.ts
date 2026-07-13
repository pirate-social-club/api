import {
  KARAOKE_SCORING_VERSION,
  type KaraokeScoringPolicy,
  type KaraokeSessionSummary,
} from "@pirate-social-club/karaoke-runtime"
import type { ProfileRepository, UserRepository } from "../auth/repositories"
import { openCommunityReadClient } from "../communities/community-read-access"
import type { CommunityRepository } from "../communities/community-repository-types"
import { executeFirst } from "../db-helpers"
import { badRequestError, notFoundError } from "../errors"
import { makeId } from "../helpers"
import { getPostKaraokePayload } from "../posts/post-karaoke-service"
import type { ReadClient } from "../sql-client"
import { rowValue, stringOrNull } from "../sql-row"
import type { ActorContext, AdminActorContext } from "../auth-middleware"
import type { Env, Profile, SongKaraokePayload } from "../../types"
import { decodePublicSongArtifactBundleId, publicCommunityId, publicPostId } from "../public-ids"
import { getControlPlaneClient } from "../runtime-deps"
import { getSongArtifactBundle } from "../song-artifacts/song-artifact-repository"
import { resolveCommunityKaraokeScoringPolicy } from "../communities/community-karaoke-policy-service"
import { emitKaraokeQualification } from "../rewards/reward-qualification-outbox"

export type KaraokeAttemptCompletionReason =
  | "abandoned"
  | "completed"
  | "provider_unavailable"
  | "session_error"

export type KaraokeTimingTrend = "early" | "late" | "mixed" | "on_time"

export interface RecordKaraokeAttemptResult {
  inserted: boolean
  rankEligible: boolean
  streakCredited: boolean
}

type KaraokeLeaderboardIdentity = {
  avatar_ref: string | null
  display_name: string | null
  handle: string | null
  visibility: "anonymized" | "visible"
}

type KaraokeLeaderboardEntry = {
  identity: KaraokeLeaderboardIdentity
  is_viewer: boolean
  rank: number
  reached_at: string
  score: number
  top_percent: number
}

type KaraokeSongLeaderboard = {
  community_id: string
  entries: KaraokeLeaderboardEntry[]
  karaoke_revision_id: string
  object: "karaoke_song_leaderboard"
  period_end: string | null
  period_start: string | null
  post_id: string
  scope: "all_time"
  scoring_model: string
  scoring_provider: string
  scoring_version: number
  total_ranked: number
  viewer_best_reached_at: string | null
  viewer_best_score: number | null
  viewer_eligible_attempt_count: number
  viewer_rank: number | null
  viewer_top_percent: number | null
}

type RankedKaraokeAttemptRow = {
  completed_at: unknown
  final_score: unknown
  rank: unknown
  total_ranked: unknown
  user_id: unknown
}

const KARAOKE_MIN_MEASURED_LINES = 5
const KARAOKE_MIN_COVERAGE_BPS = 8500
const KARAOKE_STREAK_PASS_SCORE_BPS = 7000
const KARAOKE_SCORE_SCALE = 10_000

const KARAOKE_LEADERBOARD_DEFAULT_LIMIT = 50
const KARAOKE_LEADERBOARD_MAX_LIMIT = 100

function karaokeLeaderboardRankedCte(): string {
  return `
      WITH eligible AS (
        SELECT ka.user_id, ka.final_score, ka.completed_at, ka.id
        FROM karaoke_attempt ka
        WHERE ka.post_id = ?1
          AND ka.karaoke_revision_id = ?2
          AND ka.scoring_version = ?3
          AND ka.scoring_provider = ?4
          AND ka.scoring_model = ?5
          AND ka.rank_eligible = 1
          AND NOT EXISTS (
            SELECT 1
            FROM community_memberships cm
            WHERE cm.community_id = ka.community_id
              AND cm.user_id = ka.user_id
              AND cm.status = 'banned'
          )
      ),
      best AS (
        SELECT user_id, final_score, completed_at, id
        FROM (
          SELECT user_id, final_score, completed_at, id,
                 ROW_NUMBER() OVER (
                   PARTITION BY user_id
                   ORDER BY final_score DESC, completed_at ASC, id ASC
                 ) AS user_best_rank
          FROM eligible
        )
        WHERE user_best_rank = 1
      ),
      ranked AS (
        SELECT user_id, final_score, completed_at,
               RANK() OVER (ORDER BY final_score DESC, completed_at ASC, user_id ASC) AS rank,
               COUNT(*) OVER () AS total_ranked
        FROM best
      )
    `
}

export const karaokeAttemptServiceTestHooks = {
  karaokeLeaderboardRankedCte,
}

function clampKaraokeLeaderboardLimit(value?: number | null): number {
  if (value == null || !Number.isFinite(value)) return KARAOKE_LEADERBOARD_DEFAULT_LIMIT
  return Math.min(KARAOKE_LEADERBOARD_MAX_LIMIT, Math.max(1, Math.trunc(value)))
}

function topPercent(rank: number, total: number): number {
  if (total <= 0 || rank <= 0) return 0
  return Math.max(1, Math.min(100, Math.ceil((rank / total) * 100)))
}

function identityFromProfile(profile: Profile | null | undefined): KaraokeLeaderboardIdentity {
  if (!profile) {
    return {
      avatar_ref: null,
      display_name: null,
      handle: null,
      visibility: "anonymized",
    }
  }
  return {
    avatar_ref: profile.avatar_ref ?? null,
    display_name: profile.display_name ?? null,
    handle: profile.primary_public_handle?.label ?? profile.global_handle?.label ?? null,
    visibility: "visible",
  }
}

async function resolveKaraokeLeaderboardIdentities(
  profileRepository: ProfileRepository,
  userIds: string[],
): Promise<Map<string, KaraokeLeaderboardIdentity>> {
  const uniqueUserIds = Array.from(new Set(userIds.map((userId) => userId.trim()).filter(Boolean)))
  const profiles = profileRepository.listProfilesByUserIds
    ? await profileRepository.listProfilesByUserIds(uniqueUserIds)
    : new Map(await Promise.all(uniqueUserIds.map(async (userId) => [userId, await profileRepository.getProfileByUserId(userId)] as const)))
  const identities = new Map<string, KaraokeLeaderboardIdentity>()
  for (const userId of uniqueUserIds) {
    identities.set(userId, identityFromProfile(profiles.get(userId)))
  }
  return identities
}

function requireEnabledScoringPolicy(policy: KaraokeScoringPolicy): { model: string; provider: string } {
  if (policy.kind !== "enabled") {
    throw notFoundError("Karaoke leaderboard is not available")
  }
  return {
    model: policy.model,
    provider: policy.provider,
  }
}

async function resolveCurrentKaraokeTuple(input: {
  actor: ActorContext | AdminActorContext
  communityId: string
  communityRepository: CommunityRepository
  env: Env
  postId: string
  profileRepository: ProfileRepository
  userRepository: UserRepository
}): Promise<{
  karaokeRevisionId: string
  payload: SongKaraokePayload
  scoringModel: string
  scoringProvider: string
}> {
  const [payload, scoringPolicy] = await Promise.all([
    getPostKaraokePayload({
      actor: input.actor,
      communityId: input.communityId,
      communityRepository: input.communityRepository,
      env: input.env,
      postId: input.postId,
      profileRepository: input.profileRepository,
      userRepository: input.userRepository,
    }),
    resolveCommunityKaraokeScoringPolicy({
      communityId: input.communityId,
      communityRepository: input.communityRepository,
      env: input.env,
    }),
  ])
  const scoring = requireEnabledScoringPolicy(scoringPolicy)
  const songArtifactBundleRef = payload.song ?? payload.id
  const bundle = await getSongArtifactBundle(
    getControlPlaneClient(input.env),
    input.communityId,
    decodePublicSongArtifactBundleId(songArtifactBundleRef),
  )
  if (!bundle?.karaoke_revision_id) {
    throw notFoundError("Karaoke leaderboard is not available")
  }
  return {
    karaokeRevisionId: bundle.karaoke_revision_id,
    payload,
    scoringModel: scoring.model,
    scoringProvider: scoring.provider,
  }
}

function rankedEntry(input: {
  identity: KaraokeLeaderboardIdentity
  row: RankedKaraokeAttemptRow
  userId: string
  viewerUserId: string
}): KaraokeLeaderboardEntry {
  const rank = Number(input.row.rank ?? 0)
  const totalRanked = Number(input.row.total_ranked ?? 0)
  return {
    identity: input.identity,
    is_viewer: input.userId === input.viewerUserId,
    rank,
    reached_at: stringOrNull(input.row.completed_at) ?? "",
    score: Number(input.row.final_score ?? 0),
    top_percent: topPercent(rank, totalRanked),
  }
}

function scoreBps(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null
  return Math.max(0, Math.min(KARAOKE_SCORE_SCALE, Math.round(value * KARAOKE_SCORE_SCALE)))
}

function measuredCoverageBps(summary: KaraokeSessionSummary): number {
  if (!Number.isSafeInteger(summary.lineCount) || summary.lineCount <= 0) {
    return 0
  }
  return Math.floor((summary.scoredLineCount * KARAOKE_SCORE_SCALE) / summary.lineCount)
}

function isRankEligible(input: {
  completionReason: KaraokeAttemptCompletionReason
  finalScoreBps: number
  summary: KaraokeSessionSummary
}): boolean {
  return input.completionReason === "completed"
    && input.summary.scoredLineCount >= KARAOKE_MIN_MEASURED_LINES
    && measuredCoverageBps(input.summary) >= KARAOKE_MIN_COVERAGE_BPS
    && input.finalScoreBps >= KARAOKE_STREAK_PASS_SCORE_BPS
}

type ComputedStreak = {
  bestStreak: number
  currentStreak: number
  lastQualifiedDate: string
  streakStartedDate: string
  totalQualifiedDays: number
}

function dayOrdinal(date: string): number {
  const parsed = Date.parse(`${date}T00:00:00.000Z`)
  return Number.isFinite(parsed) ? Math.floor(parsed / 86_400_000) : NaN
}

function computeStreakFromQualifiedDates(dates: string[]): ComputedStreak | null {
  const uniqueDates = Array.from(new Set(dates.map((date) => date.trim()).filter(Boolean))).sort()
  if (uniqueDates.length === 0) return null

  let bestStreak = 0
  let runLength = 0
  let runStart = uniqueDates[0]
  let previousOrdinal: number | null = null
  let currentRunStart = uniqueDates[0]

  for (const date of uniqueDates) {
    const ordinal = dayOrdinal(date)
    if (!Number.isFinite(ordinal)) continue
    if (previousOrdinal != null && ordinal === previousOrdinal + 1) {
      runLength += 1
    } else {
      runLength = 1
      currentRunStart = date
    }
    if (runLength > bestStreak) bestStreak = runLength
    previousOrdinal = ordinal
    runStart = currentRunStart
  }

  if (previousOrdinal == null) return null
  return {
    bestStreak,
    currentStreak: runLength,
    lastQualifiedDate: uniqueDates[uniqueDates.length - 1],
    streakStartedDate: runStart,
    totalQualifiedDays: uniqueDates.length,
  }
}

async function materializeKaraokeStreakFromLedger(input: {
  client: ReadClient
  communityId: string
  now: string
  postId: string
  userId: string
}): Promise<void> {
  const rows = await input.client.execute({
    sql: `
      SELECT activity_date
      FROM song_engagement_days
      WHERE user_id = ?1
        AND post_id = ?2
        AND qualified = 1
      ORDER BY activity_date ASC
    `,
    args: [input.userId, input.postId],
  })
  const computed = computeStreakFromQualifiedDates(rows.rows.map((row) => stringOrNull(rowValue(row, "activity_date")) ?? ""))
  if (!computed) return

  await input.client.execute({
    sql: `
      INSERT INTO song_streaks (
        user_id, post_id, community_id, current_streak, best_streak,
        last_qualified_date, streak_started_date, total_qualified_days,
        created_at, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
      ON CONFLICT(user_id, post_id) DO UPDATE SET
        current_streak = ?4,
        best_streak = MAX(song_streaks.best_streak, ?5),
        last_qualified_date = ?6,
        streak_started_date = ?7,
        total_qualified_days = ?8,
        updated_at = ?9
    `,
    args: [
      input.userId,
      input.postId,
      input.communityId,
      computed.currentStreak,
      computed.bestStreak,
      computed.lastQualifiedDate,
      computed.streakStartedDate,
      computed.totalQualifiedDays,
      input.now,
    ],
  })
}

export async function recordKaraokeAttempt(input: {
  activityDate: string
  client: ReadClient
  communityId: string
  completedAt: string
  completionReason: KaraokeAttemptCompletionReason
  karaokeRevisionId: string
  postId: string
  scoringModel: string
  scoringProvider: string
  sessionId: string
  attemptId: string
  summary: KaraokeSessionSummary
  userId: string
  emitRewardQualification?: boolean
}): Promise<RecordKaraokeAttemptResult> {
  const finalScoreBps = scoreBps(input.summary.finalScore) ?? 0
  const lyricsScoreBps = scoreBps(input.summary.lyricsScore) ?? 0
  const timingScoreBps = scoreBps(input.summary.timingScore)
  const rankEligible = isRankEligible({
    completionReason: input.completionReason,
    finalScoreBps,
    summary: input.summary,
  })

  const inserted = await input.client.execute({
    sql: `
      INSERT OR IGNORE INTO karaoke_attempt (
        id, session_id, attempt_id, user_id, post_id, community_id,
        karaoke_revision_id, scoring_version, scoring_provider, scoring_model,
        final_score, lyrics_score, timing_score, timing_trend,
        scored_line_count, line_count, uncertain_line_count,
        no_recognition_line_count, low_confidence_line_count,
        completion_reason, rank_eligible, activity_date, completed_at, created_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6,
        ?7, ?8, ?9, ?10,
        ?11, ?12, ?13, ?14,
        ?15, ?16, ?17,
        ?18, ?19,
        ?20, ?21, ?22, ?23, ?23
      )
    `,
    args: [
      makeId("kat"),
      input.sessionId,
      input.attemptId,
      input.userId,
      input.postId,
      input.communityId,
      input.karaokeRevisionId,
      KARAOKE_SCORING_VERSION,
      input.scoringProvider,
      input.scoringModel,
      finalScoreBps,
      lyricsScoreBps,
      timingScoreBps,
      input.summary.timingTrend,
      input.summary.scoredLineCount,
      input.summary.lineCount,
      input.summary.uncertainLineCount,
      input.summary.noRecognitionLineCount,
      input.summary.lowConfidenceLineCount,
      input.completionReason,
      rankEligible ? 1 : 0,
      input.activityDate,
      input.completedAt,
    ],
  })

  const wasInserted = (inserted.rowsAffected ?? 0) > 0
  if (!wasInserted) {
    return {
      inserted: false,
      rankEligible,
      streakCredited: false,
    }
  }

  if (!rankEligible) {
    return {
      inserted: true,
      rankEligible,
      streakCredited: false,
    }
  }

  await input.client.execute({
    sql: `
      INSERT INTO song_engagement_days (
        user_id, post_id, community_id, activity_date,
        study_attempt_count, study_correct_count, study_target_count,
        karaoke_pass_count, qualified, created_at, updated_at
      )
      VALUES (?1, ?2, ?3, ?4, 0, 0, 10, 1, 1, ?5, ?5)
      ON CONFLICT(user_id, post_id, activity_date) DO UPDATE SET
        karaoke_pass_count = song_engagement_days.karaoke_pass_count + 1,
        qualified = 1,
        updated_at = ?5
    `,
    args: [
      input.userId,
      input.postId,
      input.communityId,
      input.activityDate,
      input.completedAt,
    ],
  })
  if (input.emitRewardQualification) {
    await emitKaraokeQualification({
      attemptId: input.attemptId,
      client: input.client,
      communityId: input.communityId,
      finalScoreBps,
      karaokeRevisionId: input.karaokeRevisionId,
      now: input.completedAt,
      postId: input.postId,
      scoringVersion: KARAOKE_SCORING_VERSION,
      sessionId: input.sessionId,
      userId: input.userId,
    })
  }
  await materializeKaraokeStreakFromLedger({
    client: input.client,
    communityId: input.communityId,
    now: input.completedAt,
    postId: input.postId,
    userId: input.userId,
  })

  return {
    inserted: true,
    rankEligible,
    streakCredited: true,
  }
}

export async function getPostKaraokeLeaderboard(input: {
  actor: ActorContext | AdminActorContext
  communityId: string
  communityRepository: CommunityRepository
  env: Env
  limit?: number | null
  postId: string
  profileRepository: ProfileRepository
  scope?: string | null
  userRepository: UserRepository
}): Promise<KaraokeSongLeaderboard> {
  const scope = input.scope?.trim() || "all_time"
  if (scope !== "all_time") {
    throw badRequestError("Only all_time karaoke leaderboard scope is supported")
  }
  const limit = clampKaraokeLeaderboardLimit(input.limit)
  const tuple = await resolveCurrentKaraokeTuple(input)
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    const rankedCte = karaokeLeaderboardRankedCte()
    const queryArgs = [
      input.postId,
      tuple.karaokeRevisionId,
      KARAOKE_SCORING_VERSION,
      tuple.scoringProvider,
      tuple.scoringModel,
    ]
    const [topResult, viewerRow, viewerAttemptCountRow] = await Promise.all([
      db.client.execute({
        sql: `
          ${rankedCte}
          SELECT user_id, final_score, completed_at, rank, total_ranked
          FROM ranked
          ORDER BY rank ASC, completed_at ASC, user_id ASC
          LIMIT ?6
        `,
        args: [...queryArgs, limit],
      }),
      executeFirst(db.client, {
        sql: `
          ${rankedCte}
          SELECT user_id, final_score, completed_at, rank, total_ranked
          FROM ranked
          WHERE user_id = ?6
          LIMIT 1
        `,
        args: [...queryArgs, input.actor.userId],
      }) as Promise<RankedKaraokeAttemptRow | null>,
      executeFirst(db.client, {
        sql: `
          SELECT COUNT(*) AS attempt_count
          FROM karaoke_attempt
          WHERE user_id = ?1
            AND post_id = ?2
            AND karaoke_revision_id = ?3
            AND scoring_version = ?4
            AND scoring_provider = ?5
            AND scoring_model = ?6
            AND rank_eligible = 1
        `,
        args: [
          input.actor.userId,
          input.postId,
          tuple.karaokeRevisionId,
          KARAOKE_SCORING_VERSION,
          tuple.scoringProvider,
          tuple.scoringModel,
        ],
      }) as Promise<Record<string, unknown> | null>,
    ])
    const topRows = topResult.rows as RankedKaraokeAttemptRow[]
    const userIds = [
      ...topRows.map((row) => stringOrNull(row.user_id) ?? ""),
      stringOrNull(viewerRow?.user_id) ?? "",
    ].filter(Boolean)
    const identities = await resolveKaraokeLeaderboardIdentities(input.profileRepository, userIds)
    const entries = topRows.map((row) => {
      const userId = stringOrNull(row.user_id) ?? ""
      return rankedEntry({
        identity: identities.get(userId) ?? identityFromProfile(null),
        row,
        userId,
        viewerUserId: input.actor.userId,
      })
    })
    const viewerRank = viewerRow ? Number(viewerRow.rank ?? 0) : null
    const totalRanked = Number(topRows[0]?.total_ranked ?? viewerRow?.total_ranked ?? 0)
    return {
      community_id: publicCommunityId(input.communityId),
      entries,
      karaoke_revision_id: tuple.karaokeRevisionId,
      object: "karaoke_song_leaderboard",
      period_end: null,
      period_start: null,
      post_id: publicPostId(input.postId),
      scope: "all_time",
      scoring_model: tuple.scoringModel,
      scoring_provider: tuple.scoringProvider,
      scoring_version: KARAOKE_SCORING_VERSION,
      total_ranked: totalRanked,
      viewer_best_reached_at: stringOrNull(viewerRow?.completed_at),
      viewer_best_score: viewerRow ? Number(viewerRow.final_score ?? 0) : null,
      viewer_eligible_attempt_count: Number(rowValue(viewerAttemptCountRow, "attempt_count") ?? 0),
      viewer_rank: viewerRank,
      viewer_top_percent: viewerRank ? topPercent(viewerRank, totalRanked) : null,
    }
  } finally {
    db.close()
  }
}
