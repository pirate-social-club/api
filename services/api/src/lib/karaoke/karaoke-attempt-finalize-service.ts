import type { KaraokeSessionSummary } from "@pirate-social-club/karaoke-runtime"
import { getCommunityRepository } from "../communities/db-community-repository"
import { openCommunityWriteClient } from "../communities/community-read-access"
import { executeFirst } from "../db-helpers"
import { HttpError, internalError, notFoundError } from "../errors"
import { getControlPlaneClient } from "../runtime-deps"
import { rowValue, stringOrNull } from "../sql-row"
import type { Env } from "../../env"
import { envFlag } from "../helpers"
import { getSongArtifactBundle } from "../song-artifacts/song-artifact-repository"
import {
  isKaraokeAttemptRankEligible,
  recordKaraokeAttempt,
  type KaraokeAttemptCompletionReason,
} from "./karaoke-attempt-service"
import { claimStreakTimezonePin, prepareStreakWrite } from "../posts/post-study-streak-write-service"
import { getKaraokeSessionCreationRecordBySession } from "./session-creation-repository"

export interface FinalizeKaraokeAttemptResult {
  inserted: boolean
  rank_eligible: boolean
  streak_credited: boolean
}

function isCompletionReason(value: unknown): value is KaraokeAttemptCompletionReason {
  return value === "abandoned"
    || value === "completed"
    || value === "provider_unavailable"
    || value === "session_error"
}

function isSummary(value: unknown): value is KaraokeSessionSummary {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const summary = value as Partial<KaraokeSessionSummary>
  return typeof summary.finalScore === "number"
    && typeof summary.lyricsScore === "number"
    && (typeof summary.timingScore === "number" || summary.timingScore === null)
    && typeof summary.lineCount === "number"
    && typeof summary.scoredLineCount === "number"
    && typeof summary.uncertainLineCount === "number"
    && typeof summary.noRecognitionLineCount === "number"
    && typeof summary.lowConfidenceLineCount === "number"
    && (summary.timingTrend === "early" || summary.timingTrend === "late" || summary.timingTrend === "mixed" || summary.timingTrend === "on_time")
}

/**
 * Emits the take's timing-calibration verdict as a structured log line.
 *
 * Timing was pulled from grading in v3 precisely because we could not see, from
 * production, WHY it was producing nonsense — the attempt row keeps only a null
 * timing score and a coarse trend, and the per-line measurements die with the
 * session. This is the cheapest durable fix: the offset the scorer estimated,
 * the residual spread, and the reason it did or did not count, on every
 * finalize, with no schema change and no raw audio/transcript.
 *
 * Read defensively: a client (or an API bundling an older karaoke-runtime) may
 * send a summary with no calibration block at all.
 */
function logTimingCalibration(input: {
  summary: KaraokeSessionSummary
  sessionId: string
  attemptId: string
  communityId: string
  postId: string
}): void {
  const calibration = (input.summary as Partial<KaraokeSessionSummary> & {
    timingCalibration?: {
      state?: unknown
      reason?: unknown
      offsetMs?: unknown
      rawOffsetMs?: unknown
      residualSpreadMs?: unknown
      measuredLineCount?: unknown
      matchedWordCount?: unknown
    }
  }).timingCalibration

  console.info("[karaoke-scoring] timing calibration", {
    attempt_id: input.attemptId,
    community_id: input.communityId,
    matched_word_count: calibration?.matchedWordCount ?? null,
    measured_line_count: calibration?.measuredLineCount ?? null,
    offset_ms: calibration?.offsetMs ?? null,
    post_id: input.postId,
    raw_offset_ms: calibration?.rawOffsetMs ?? null,
    residual_spread_ms: calibration?.residualSpreadMs ?? null,
    scored_line_count: input.summary.scoredLineCount,
    session_id: input.sessionId,
    // "absent" distinguishes a pre-v4 client from a v4 client that failed to
    // calibrate — without it the two look identical in the logs.
    state: calibration?.state ?? "absent",
    timing_reason: calibration?.reason ?? null,
    timing_score: input.summary.timingScore,
    timing_trend: input.summary.timingTrend,
  })
}

function requireDateString(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    throw new HttpError(400, "invalid_karaoke_finalize_payload", `${field} must be a UTC date`, false)
  }
  return value
}

function requireIsoString(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new HttpError(400, "invalid_karaoke_finalize_payload", `${field} must be an ISO timestamp`, false)
  }
  return value
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new HttpError(400, "invalid_karaoke_finalize_payload", `${field} is required`, false)
  }
  return value.trim()
}

function parseStoredScoringPolicy(json: string | null): { model: string; provider: string } {
  if (!json) {
    throw internalError("Karaoke session creation is missing scoring policy")
  }
  try {
    const policy = JSON.parse(json) as Record<string, unknown>
    if (
      policy.kind !== "enabled"
      || typeof policy.provider !== "string"
      || !policy.provider.trim()
      || typeof policy.model !== "string"
      || !policy.model.trim()
    ) {
      throw new Error("invalid scoring policy")
    }
    return {
      model: policy.model.trim(),
      provider: policy.provider.trim(),
    }
  } catch {
    throw internalError("Karaoke session creation has invalid scoring policy")
  }
}

export function parseFinalizeKaraokeAttemptPayload(value: unknown): {
  activityDate: string
  activityTimezone: string | null
  attemptId: string
  completedAt: string
  completionReason: KaraokeAttemptCompletionReason
  sessionId: string
  sessionStartedAt: string | null
  summary: KaraokeSessionSummary
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_karaoke_finalize_payload", "Finalize payload must be an object", false)
  }
  const record = value as Record<string, unknown>
  const completionReason = record.completion_reason
  if (!isCompletionReason(completionReason)) {
    throw new HttpError(400, "invalid_karaoke_finalize_payload", "completion_reason is invalid", false)
  }
  if (!isSummary(record.summary)) {
    throw new HttpError(400, "invalid_karaoke_finalize_payload", "summary is invalid", false)
  }
  // Optional streak-owner-timezone metadata. Older runtimes do not send these;
  // invalid values are dropped here and re-validated at pin resolution.
  const activityTimezone = typeof record.activity_timezone === "string" && record.activity_timezone.trim()
    ? record.activity_timezone.trim()
    : null
  const sessionStartedAt = typeof record.session_started_at === "string" && Number.isFinite(Date.parse(record.session_started_at))
    ? record.session_started_at
    : null
  return {
    activityDate: requireDateString(record.activity_date, "activity_date"),
    activityTimezone,
    attemptId: requireString(record.attempt_id, "attempt_id"),
    completedAt: requireIsoString(record.completed_at, "completed_at"),
    completionReason,
    sessionId: requireString(record.session_id, "session_id"),
    sessionStartedAt,
    summary: record.summary,
  }
}

export async function finalizeKaraokeAttempt(input: {
  env: Env
  payload: ReturnType<typeof parseFinalizeKaraokeAttemptPayload>
}): Promise<FinalizeKaraokeAttemptResult> {
  const controlClient = getControlPlaneClient(input.env)
  const creation = await getKaraokeSessionCreationRecordBySession({
    attemptId: input.payload.attemptId,
    client: controlClient,
    sessionId: input.payload.sessionId,
  })
  if (!creation || creation.status !== "initialized") {
    throw notFoundError("Karaoke session not found")
  }

  const communityRepository = getCommunityRepository(input.env)
  const db = await openCommunityWriteClient(input.env, communityRepository, creation.communityId)
  try {
    const postRow = await executeFirst(db.client, {
      sql: `
        SELECT song_artifact_bundle_id
        FROM posts
        WHERE community_id = ?1
          AND post_id = ?2
          AND post_type = 'song'
        LIMIT 1
      `,
      args: [creation.communityId, creation.postId],
    })
    const songArtifactBundleId = stringOrNull(rowValue(postRow, "song_artifact_bundle_id"))
    if (!songArtifactBundleId) {
      throw internalError("Karaoke finalization post is missing song artifact bundle")
    }
    const bundle = await getSongArtifactBundle(controlClient, creation.communityId, songArtifactBundleId)
    if (!bundle?.karaoke_revision_id) {
      throw internalError("Karaoke finalization bundle is missing karaoke revision")
    }
    const scoringPolicy = parseStoredScoringPolicy(creation.scoringPolicyJson)

    const existingAttempt = await executeFirst(db.client, {
      sql: `
        SELECT rank_eligible
        FROM karaoke_attempt
        WHERE session_id = ?1
          AND attempt_id = ?2
        LIMIT 1
      `,
      args: [input.payload.sessionId, input.payload.attemptId],
    })
    if (existingAttempt) {
      return {
        inserted: false,
        rank_eligible: Number(rowValue(existingAttempt, "rank_eligible")) === 1,
        streak_credited: false,
      }
    }

    logTimingCalibration({
      attemptId: input.payload.attemptId,
      communityId: creation.communityId,
      postId: creation.postId,
      sessionId: input.payload.sessionId,
      summary: input.payload.summary,
    })

    // The pin claim is a compare-and-swap that must COMMIT before the
    // preparation read (concurrent first qualifiers can't out-race it), and
    // the preparation read must happen before the buffered write tx opens.
    const streakPreparation = isKaraokeAttemptRankEligible({
      completionReason: input.payload.completionReason,
      summary: input.payload.summary,
    })
      ? await (async () => {
        await claimStreakTimezonePin({
          client: db.client,
          communityId: creation.communityId,
          now: input.payload.completedAt,
          postId: creation.postId,
          timezoneCandidate: input.payload.activityTimezone,
          userId: creation.subjectUserId,
        })
        return prepareStreakWrite({
          activityInstant: input.payload.sessionStartedAt ?? input.payload.completedAt,
          client: db.client,
          now: input.payload.completedAt,
          postId: creation.postId,
          qualified: true,
          timezoneCandidate: input.payload.activityTimezone,
          userId: creation.subjectUserId,
        })
      })()
      : undefined

    const tx = await db.client.transaction("write")
    try {
      const result = await recordKaraokeAttempt({
        activityDate: input.payload.activityDate,
        attemptId: input.payload.attemptId,
        client: tx,
        communityId: creation.communityId,
        completedAt: input.payload.completedAt,
        completionReason: input.payload.completionReason,
        karaokeRevisionId: bundle.karaoke_revision_id,
        postId: creation.postId,
        scoringModel: scoringPolicy.model,
        scoringProvider: scoringPolicy.provider,
        sessionId: input.payload.sessionId,
        streakPreparation,
        summary: input.payload.summary,
        userId: creation.subjectUserId,
        attemptKnownAbsent: true,
        emitRewardQualification: envFlag(input.env.REWARDS_CAMPAIGNS_ENABLED, false)
          && envFlag(input.env.REWARDS_ACCRUAL_ENABLED, false),
      })
      await tx.commit()
      return {
        inserted: result.inserted,
        rank_eligible: result.rankEligible,
        streak_credited: result.streakCredited,
      }
    } catch (error) {
      await tx.rollback().catch(() => undefined)
      throw error
    } finally {
      tx.close()
    }
  } finally {
    db.close()
  }
}
