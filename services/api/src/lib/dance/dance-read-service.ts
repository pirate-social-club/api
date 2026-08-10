import type { Env } from "../../env"
import {
  openCommunityReadClient,
  type CommunityReadHandle,
} from "../communities/community-read-access"
import { getCommunityRepository } from "../communities/db-community-repository"
import { executeFirst } from "../db-helpers"
import { internalError } from "../errors"
import { publicPostId } from "../public-ids"
import { rowValue, stringOrNull } from "../sql-row"
import type { Client } from "../sql-client"
import {
  getDanceAttemptSessionByAttemptId,
  type DanceAttemptSessionRecord,
} from "./attempt-session-repository"

export type DanceAttemptReadRecord = {
  attemptId: string
  sessionId: string
  hostPostId: string
  choreographyRevisionId: string
  status: "initialized" | "uploading" | "submitted" | "grading" | "passed" | "rejected" | "failed" | "expired"
  scoreBps: number | null
  rankEligible: boolean | null
  reason: string | null
  coverageBps: number | null
  poseDetectionBps: number | null
  durationRatioBps: number | null
  completedAt: string | null
}

function nullableInteger(row: unknown, field: string): number | null {
  const value = rowValue(row, field)
  if (value === null || value === undefined) return null
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized)) {
    throw internalError(`Dance attempt has invalid ${field}`)
  }
  return normalized
}

function pendingAttempt(session: DanceAttemptSessionRecord): DanceAttemptReadRecord {
  const status = session.status === "finalized" ? "passed" : session.status
  if (![
    "initialized",
    "uploading",
    "submitted",
    "grading",
    "rejected",
    "failed",
    "expired",
    "passed",
  ].includes(status)) {
    throw internalError("Dance attempt session has invalid public status")
  }
  return {
    attemptId: session.attemptId,
    sessionId: session.sessionId,
    hostPostId: session.hostPostId,
    choreographyRevisionId: session.choreographyRevisionId,
    status: status as DanceAttemptReadRecord["status"],
    scoreBps: session.scoreBps,
    rankEligible: session.calibrationAdmitted === null ? null : false,
    reason: session.terminalReason,
    coverageBps: null,
    poseDetectionBps: null,
    durationRatioBps: null,
    completedAt: session.finalizedAt,
  }
}

function terminalAttempt(
  session: DanceAttemptSessionRecord,
  row: unknown,
): DanceAttemptReadRecord {
  const status = stringOrNull(rowValue(row, "status"))
  if (status !== "passed" && status !== "rejected" && status !== "failed") {
    throw internalError("Dance attempt has invalid terminal status")
  }
  const rankEligible = nullableInteger(row, "rank_eligible")
  if (rankEligible !== 0 && rankEligible !== 1) {
    throw internalError("Dance attempt has invalid rank_eligible")
  }
  const completedAt = stringOrNull(rowValue(row, "completed_at"))
  if (!completedAt) throw internalError("Dance attempt is missing completed_at")
  return {
    attemptId: session.attemptId,
    sessionId: session.sessionId,
    hostPostId: session.hostPostId,
    choreographyRevisionId: session.choreographyRevisionId,
    status,
    scoreBps: nullableInteger(row, "score_bps"),
    rankEligible: rankEligible === 1,
    reason: stringOrNull(rowValue(row, "reason_code")),
    coverageBps: nullableInteger(row, "coverage_bps"),
    poseDetectionBps: nullableInteger(row, "pose_detection_bps"),
    durationRatioBps: nullableInteger(row, "duration_ratio_bps"),
    completedAt,
  }
}

export async function getDanceAttemptForUser(input: {
  env: Env
  attemptId: string
  subjectUserId: string
  controlClient: Client
  openCommunityRead?: (communityId: string) => Promise<CommunityReadHandle>
}): Promise<DanceAttemptReadRecord | null> {
  const session = await getDanceAttemptSessionByAttemptId({
    client: input.controlClient,
    attemptId: input.attemptId,
    subjectUserId: input.subjectUserId,
  })
  if (!session) return null
  if (!session.finalizedAt || session.status === "expired") {
    return pendingAttempt(session)
  }

  const communityRepository = input.openCommunityRead
    ? null
    : getCommunityRepository(input.env)
  let handle: Awaited<ReturnType<typeof openCommunityReadClient>> | null = null
  try {
    handle = input.openCommunityRead
      ? await input.openCommunityRead(session.communityId)
      : await openCommunityReadClient(
        input.env,
        communityRepository!,
        session.communityId,
      )
    const row = await executeFirst(handle.client, {
      sql: `
        SELECT status, score_bps, rank_eligible, reason_code,
          coverage_bps, pose_detection_bps, duration_ratio_bps, completed_at
        FROM dance_attempt
        WHERE dance_attempt_id = ?1 AND user_id = ?2
      `,
      args: [session.attemptId, input.subjectUserId],
    })
    if (!row) throw internalError("Terminal dance attempt evidence is missing")
    return terminalAttempt(session, row)
  } finally {
    await handle?.close()
    await communityRepository?.close?.()
  }
}

function epochSeconds(value: string | null): number | null {
  if (value === null) return null
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw internalError("Dance timestamp is invalid")
  return Math.floor(milliseconds / 1000)
}

export function serializeDanceSession(record: DanceAttemptSessionRecord) {
  return {
    id: record.sessionId,
    object: "dance_session" as const,
    attempt: record.attemptId,
    post: publicPostId(record.hostPostId),
    choreography: record.choreographyId,
    choreography_revision: record.choreographyRevisionId,
    status: record.status,
    max_bytes: record.maximumBytes,
    expires_at: epochSeconds(record.expiresAt),
    created: epochSeconds(record.createdAt),
  }
}

export function serializeDanceAttempt(record: DanceAttemptReadRecord) {
  return {
    id: record.attemptId,
    object: "dance_attempt" as const,
    session: record.sessionId,
    post: publicPostId(record.hostPostId),
    choreography_revision: record.choreographyRevisionId,
    status: record.status,
    score_bps: record.scoreBps,
    rank_eligible: record.rankEligible,
    reason: record.reason,
    coverage_bps: record.coverageBps,
    pose_detection_bps: record.poseDetectionBps,
    duration_ratio_bps: record.durationRatioBps,
    completed_at: epochSeconds(record.completedAt),
  }
}
