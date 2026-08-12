import { executeFirst } from "../db-helpers"
import { rowValue, stringOrNull } from "../sql-row"
import type { Client } from "../sql-client"
import { withTransaction } from "../transactions"

export type DanceAttemptDispatchRecord = {
  sessionId: string
  attemptId: string
  uploadObjectKey: string
  observedContentSha256: string
  observedSizeBytes: number
  referenceFeatureRef: string
  referenceFeatureSha256: string
  referenceFeatureSizeBytes: number
  referenceContentSha256: string
  poseModelVersion: string
  poseModelSha256: string
  featureSchemaVersion: string
  scorerVersion: string
  artifactVersion: string
  calibrationVersion: string
  calibrationChecksum: string
  fingerprintPolicyVersion: string
  integrityPolicyVersion: string
  mirrorPolicy: string
  startCuePolicyVersion: string
  startCueKind: string
  startCueMinimumHoldMs: number
  startCueObservationWindowMs: number
  dispatchAttemptCount: number
}

function required(row: unknown, field: string): string {
  const value = stringOrNull(rowValue(row, field))
  if (!value) throw new Error(`Dance attempt dispatch row is missing ${field}`)
  return value
}

function integer(row: unknown, field: string): number {
  const value = Number(rowValue(row, field))
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Dance attempt dispatch row has invalid ${field}`)
  }
  return value
}

function toRecord(row: unknown): DanceAttemptDispatchRecord {
  return {
    sessionId: required(row, "dance_attempt_session_id"),
    attemptId: required(row, "dance_attempt_id"),
    uploadObjectKey: required(row, "upload_object_key"),
    observedContentSha256: required(row, "observed_content_sha256"),
    observedSizeBytes: integer(row, "observed_size_bytes"),
    referenceFeatureRef: required(row, "reference_feature_ref"),
    referenceFeatureSha256: required(row, "reference_feature_sha256"),
    referenceFeatureSizeBytes: integer(row, "reference_feature_size_bytes"),
    referenceContentSha256: required(row, "reference_content_sha256"),
    poseModelVersion: required(row, "pose_model_version"),
    poseModelSha256: required(row, "pose_model_sha256"),
    featureSchemaVersion: required(row, "feature_schema_version"),
    scorerVersion: required(row, "scorer_version"),
    artifactVersion: required(row, "artifact_version"),
    calibrationVersion: required(row, "required_calibration_version"),
    calibrationChecksum: required(row, "required_calibration_checksum"),
    fingerprintPolicyVersion: required(row, "required_fingerprint_policy_version"),
    integrityPolicyVersion: required(row, "required_integrity_policy_version"),
    mirrorPolicy: required(row, "mirror_policy"),
    startCuePolicyVersion: required(row, "start_cue_policy_version"),
    startCueKind: required(row, "start_cue_kind"),
    startCueMinimumHoldMs: integer(row, "start_cue_minimum_hold_ms"),
    startCueObservationWindowMs: integer(row, "start_cue_observation_window_ms"),
    dispatchAttemptCount: integer(row, "grading_dispatch_attempt_count"),
  }
}

export async function claimDueDanceAttemptDispatch(input: {
  client: Client
  now: string
  claimToken: string
  claimExpiresAt: string
}): Promise<DanceAttemptDispatchRecord | null> {
  return withTransaction(input.client, "write", async (tx) => {
    const row = await executeFirst(tx, {
      sql: `
        SELECT *
        FROM dance_attempt_sessions
        WHERE status IN ('submitted', 'grading')
          AND start_cue_policy_version IS NOT NULL
          AND start_cue_kind IS NOT NULL
          AND start_cue_minimum_hold_ms IS NOT NULL
          AND start_cue_observation_window_ms IS NOT NULL
          AND grading_next_dispatch_at <= ?1
          AND grading_dispatch_attempt_count < 5
          AND (
            grading_dispatch_claim_token IS NULL
            OR grading_dispatch_claim_expires_at <= ?1
          )
        ORDER BY grading_next_dispatch_at, created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `,
      args: [input.now],
    })
    if (!row) return null
    const sessionId = required(row, "dance_attempt_session_id")
    await tx.execute({
      sql: `
        UPDATE dance_attempt_sessions
        SET status = 'grading',
          grading_dispatch_attempt_count = grading_dispatch_attempt_count + 1,
          grading_dispatch_claim_token = ?2,
          grading_dispatch_claim_expires_at = ?3,
          updated_at = ?1
        WHERE dance_attempt_session_id = ?4
      `,
      args: [input.now, input.claimToken, input.claimExpiresAt, sessionId],
    })
    return toRecord({
      ...(row as Record<string, unknown>),
      status: "grading",
      grading_dispatch_attempt_count:
        integer(row, "grading_dispatch_attempt_count") + 1,
    })
  })
}

export async function acceptDanceAttemptDispatch(input: {
  client: Client
  sessionId: string
  claimToken: string
  dispatchId: string
  now: string
  callbackDeadline: string
}): Promise<boolean> {
  const result = await input.client.execute({
    sql: `
      UPDATE dance_attempt_sessions
      SET grading_dispatch_id = ?3, grading_dispatched_at = ?4,
        grading_next_dispatch_at = ?5,
        grading_dispatch_claim_token = NULL,
        grading_dispatch_claim_expires_at = NULL,
        grading_dispatch_last_error = NULL, updated_at = ?4
      WHERE dance_attempt_session_id = ?1
        AND grading_dispatch_claim_token = ?2
        AND status = 'grading'
    `,
    args: [
      input.sessionId,
      input.claimToken,
      input.dispatchId,
      input.now,
      input.callbackDeadline,
    ],
  })
  return (result.rowsAffected ?? result.rows.length) === 1
}

export async function rejectDanceAttemptDispatch(input: {
  client: Client
  sessionId: string
  claimToken: string
  errorCode: string
  retryAt: string
  now: string
}): Promise<boolean> {
  const result = await input.client.execute({
    sql: `
      UPDATE dance_attempt_sessions
      SET grading_next_dispatch_at = ?4,
        grading_dispatch_claim_token = NULL,
        grading_dispatch_claim_expires_at = NULL,
        grading_dispatch_last_error = ?3, updated_at = ?5
      WHERE dance_attempt_session_id = ?1
        AND grading_dispatch_claim_token = ?2
        AND status = 'grading'
    `,
    args: [
      input.sessionId,
      input.claimToken,
      input.errorCode,
      input.retryAt,
      input.now,
    ],
  })
  return (result.rowsAffected ?? result.rows.length) === 1
}
