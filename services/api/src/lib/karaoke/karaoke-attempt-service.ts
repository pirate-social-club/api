import {
  KARAOKE_SCORING_VERSION,
  type KaraokeSessionSummary,
} from "@pirate-social-club/karaoke-runtime"
import { executeFirst } from "../db-helpers"
import { makeId } from "../helpers"
import type { ReadClient } from "../sql-client"
import { materializeStudyStreak } from "../posts/post-study-service"

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

const KARAOKE_MIN_MEASURED_LINES = 5
const KARAOKE_MIN_COVERAGE_BPS = 8500
const KARAOKE_STREAK_PASS_SCORE_BPS = 7000
const KARAOKE_SCORE_SCALE = 10_000

export const KARAOKE_ATTEMPT_SCORING_PROVIDER = "pirate-karaoke-runtime"
export const KARAOKE_ATTEMPT_SCORING_MODEL = "text-timing-v1"

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

async function insertedAttemptExists(input: {
  attemptId: string
  client: ReadClient
  sessionId: string
}): Promise<boolean> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT 1 AS present
      FROM karaoke_attempt
      WHERE session_id = ?1
        AND attempt_id = ?2
      LIMIT 1
    `,
    args: [input.sessionId, input.attemptId],
  })
  return Boolean(row)
}

export async function recordKaraokeAttempt(input: {
  activityDate: string
  client: ReadClient
  communityId: string
  completedAt: string
  completionReason: KaraokeAttemptCompletionReason
  karaokeRevisionId: string
  postId: string
  sessionId: string
  attemptId: string
  summary: KaraokeSessionSummary
  userId: string
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
      KARAOKE_ATTEMPT_SCORING_PROVIDER,
      KARAOKE_ATTEMPT_SCORING_MODEL,
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
        karaoke_pass_count = CASE
          WHEN song_engagement_days.karaoke_pass_count > 0 THEN song_engagement_days.karaoke_pass_count
          ELSE 1
        END,
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
  await materializeStudyStreak({
    activityDate: input.activityDate,
    client: input.client,
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

export async function hasKaraokeAttempt(input: {
  attemptId: string
  client: ReadClient
  sessionId: string
}): Promise<boolean> {
  return insertedAttemptExists(input)
}
