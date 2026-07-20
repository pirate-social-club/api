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
  recordKaraokeAttempt,
  type KaraokeAttemptCompletionReason,
} from "./karaoke-attempt-service"
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

function requirePositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new HttpError(400, "invalid_karaoke_finalize_payload", `${field} must be a positive integer`, false)
  }
  return value
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
  attemptId: string
  completedAt: string
  completionReason: KaraokeAttemptCompletionReason
  scoringVersion: number
  sessionId: string
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
  return {
    activityDate: requireDateString(record.activity_date, "activity_date"),
    attemptId: requireString(record.attempt_id, "attempt_id"),
    completedAt: requireIsoString(record.completed_at, "completed_at"),
    completionReason,
    scoringVersion: requirePositiveInteger(record.scoring_version, "scoring_version"),
    sessionId: requireString(record.session_id, "session_id"),
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
        scoringVersion: input.payload.scoringVersion,
        sessionId: input.payload.sessionId,
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
