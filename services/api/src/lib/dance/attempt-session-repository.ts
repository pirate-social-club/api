import { executeFirst } from "../db-helpers"
import { conflictError, internalError, notFoundError } from "../errors"
import { rowValue, stringOrNull } from "../sql-row"
import type { Client, Transaction } from "../sql-client"
import { withTransaction } from "../transactions"

export const DANCE_ATTEMPT_MAX_BYTES = 64 * 1024 * 1024
export const DANCE_ATTEMPT_CALIBRATION_VERSION =
  "dance_calibration_gate0_provisional_v1"
export const DANCE_ATTEMPT_CALIBRATION_CHECKSUM =
  "9bbccca0bc17aab7d65faf7f29a4d4cac110c64473168017610b5f050c3fa50a"
export const DANCE_ATTEMPT_FINGERPRINT_POLICY_VERSION =
  "dance_motion_fingerprint_gate0_v1"
export const DANCE_ATTEMPT_INTEGRITY_POLICY_VERSION =
  "dance_integrity_gate0_v1"

export type DanceAttemptSessionRecord = {
  sessionId: string
  attemptId: string
  subjectUserId: string
  hostPostId: string
  choreographyRevisionId: string
  status: string
  uploadObjectKey: string
  maximumBytes: number
  observedSizeBytes: number | null
  observedEtag: string | null
  observedContentSha256: string | null
  expiresAt: string
}

export type CreateDanceAttemptSessionInput = {
  sessionId: string
  attemptId: string
  subjectUserId: string
  hostPostId: string
  creationIdempotencyKey: string
  activityDate: string
  activityTimezone: string
  now: string
  expiresAt: string
}

const SESSION_SELECT = `
  SELECT dance_attempt_session_id, dance_attempt_id, subject_user_id, host_post_id,
    dance_choreography_revision_id, status, upload_object_key, maximum_bytes,
    observed_size_bytes, observed_etag, observed_content_sha256, expires_at
  FROM dance_attempt_sessions
`

function requiredString(row: unknown, field: string): string {
  const value = stringOrNull(rowValue(row, field))
  if (!value) throw internalError(`Dance attempt session is missing ${field}`)
  return value
}

function nullableNumber(row: unknown, field: string): number | null {
  const value = rowValue(row, field)
  if (value === null || value === undefined) return null
  const normalized = Number(value)
  if (!Number.isSafeInteger(normalized)) {
    throw internalError(`Dance attempt session has invalid ${field}`)
  }
  return normalized
}

function toRecord(row: unknown): DanceAttemptSessionRecord {
  const maximumBytes = nullableNumber(row, "maximum_bytes")
  if (maximumBytes === null) {
    throw internalError("Dance attempt session is missing maximum_bytes")
  }
  return {
    sessionId: requiredString(row, "dance_attempt_session_id"),
    attemptId: requiredString(row, "dance_attempt_id"),
    subjectUserId: requiredString(row, "subject_user_id"),
    hostPostId: requiredString(row, "host_post_id"),
    choreographyRevisionId: requiredString(
      row,
      "dance_choreography_revision_id",
    ),
    status: requiredString(row, "status"),
    uploadObjectKey: requiredString(row, "upload_object_key"),
    maximumBytes,
    observedSizeBytes: nullableNumber(row, "observed_size_bytes"),
    observedEtag: stringOrNull(rowValue(row, "observed_etag")),
    observedContentSha256: stringOrNull(
      rowValue(row, "observed_content_sha256"),
    ),
    expiresAt: requiredString(row, "expires_at"),
  }
}

async function selectSessionForUpdate(
  tx: Transaction,
  sessionId: string,
): Promise<unknown | null> {
  return executeFirst(tx, {
    sql: `${SESSION_SELECT} WHERE dance_attempt_session_id = ?1 FOR UPDATE`,
    args: [sessionId],
  })
}

export async function getDanceAttemptSession(input: {
  client: Client
  sessionId: string
  subjectUserId: string
}): Promise<DanceAttemptSessionRecord | null> {
  const row = await executeFirst(input.client, {
    sql: `${SESSION_SELECT}
      WHERE dance_attempt_session_id = ?1 AND subject_user_id = ?2`,
    args: [input.sessionId, input.subjectUserId],
  })
  return row ? toRecord(row) : null
}

export async function createDanceAttemptSession(input: {
  client: Client
  value: CreateDanceAttemptSessionInput
}): Promise<{ kind: "created" | "idempotent"; record: DanceAttemptSessionRecord }> {
  return withTransaction(input.client, "write", async (tx) => {
    const value = input.value
    const revision = await executeFirst(tx, {
      sql: `
        SELECT c.community_id, c.host_post_id, c.referenced_song_post_id,
          c.song_artifact_bundle_id, c.dance_choreography_id,
          r.dance_choreography_revision_id, r.reference_content_sha256,
          r.reference_feature_ref, r.reference_feature_sha256,
          r.reference_feature_size_bytes, r.pose_model_version,
          r.pose_model_sha256, r.feature_schema_version, r.scorer_version,
          r.artifact_version, r.mirror_policy
        FROM dance_choreography_revisions r
        JOIN dance_choreographies c
          ON c.dance_choreography_id = r.dance_choreography_id
        WHERE c.host_post_id = ?1
          AND r.status = 'ready'
          AND c.status = 'ready'
          AND c.active_revision_id = r.dance_choreography_revision_id
        FOR UPDATE
      `,
      args: [value.hostPostId],
    })
    if (!revision) throw notFoundError("Active dance choreography revision not found")

    const placeholderKey =
      `dance/attempt-media/${value.sessionId}/pending.mp4`
    const inserted = await tx.execute({
      sql: `
        INSERT INTO dance_attempt_sessions (
          dance_attempt_session_id, dance_attempt_id, subject_user_id,
          community_id, host_post_id, referenced_song_post_id,
          song_artifact_bundle_id, dance_choreography_id,
          dance_choreography_revision_id, reference_content_sha256,
          reference_feature_ref, reference_feature_sha256,
          reference_feature_size_bytes, pose_model_version, pose_model_sha256,
          feature_schema_version, scorer_version, artifact_version,
          required_calibration_version, required_calibration_checksum,
          required_fingerprint_policy_version, required_integrity_policy_version,
          mirror_policy, status, activity_date, activity_timezone,
          creation_idempotency_key, upload_object_key, expected_mime_type,
          maximum_bytes, expires_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
          ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23,
          'initialized', ?24, ?25, ?26, ?27, 'video/mp4', ?28, ?29, ?30, ?30
        )
        ON CONFLICT (subject_user_id, creation_idempotency_key) DO NOTHING
        RETURNING dance_attempt_session_id
      `,
      args: [
        value.sessionId,
        value.attemptId,
        value.subjectUserId,
        requiredString(revision, "community_id"),
        requiredString(revision, "host_post_id"),
        requiredString(revision, "referenced_song_post_id"),
        requiredString(revision, "song_artifact_bundle_id"),
        requiredString(revision, "dance_choreography_id"),
        requiredString(revision, "dance_choreography_revision_id"),
        requiredString(revision, "reference_content_sha256"),
        requiredString(revision, "reference_feature_ref"),
        requiredString(revision, "reference_feature_sha256"),
        Number(rowValue(revision, "reference_feature_size_bytes")),
        requiredString(revision, "pose_model_version"),
        requiredString(revision, "pose_model_sha256"),
        requiredString(revision, "feature_schema_version"),
        requiredString(revision, "scorer_version"),
        requiredString(revision, "artifact_version"),
        DANCE_ATTEMPT_CALIBRATION_VERSION,
        DANCE_ATTEMPT_CALIBRATION_CHECKSUM,
        DANCE_ATTEMPT_FINGERPRINT_POLICY_VERSION,
        DANCE_ATTEMPT_INTEGRITY_POLICY_VERSION,
        requiredString(revision, "mirror_policy"),
        value.activityDate,
        value.activityTimezone,
        value.creationIdempotencyKey,
        placeholderKey,
        DANCE_ATTEMPT_MAX_BYTES,
        value.expiresAt,
        value.now,
      ],
    })

    const row = inserted.rows.length > 0
      ? await selectSessionForUpdate(tx, value.sessionId)
      : await executeFirst(tx, {
        sql: `${SESSION_SELECT}
          WHERE subject_user_id = ?1 AND creation_idempotency_key = ?2
          FOR UPDATE`,
        args: [value.subjectUserId, value.creationIdempotencyKey],
      })
    if (!row) throw internalError("Dance attempt session insert was not observable")
    const record = toRecord(row)
    if (
      record.subjectUserId !== value.subjectUserId
      || record.hostPostId !== value.hostPostId
    ) {
      throw conflictError("Dance attempt idempotency key was reused")
    }
    return {
      kind: inserted.rows.length > 0 ? "created" : "idempotent",
      record,
    }
  })
}

export async function bindDanceAttemptUploadIntent(input: {
  client: Client
  sessionId: string
  subjectUserId: string
  objectKey: string
  sizeBytes: number
  now: string
}): Promise<{ kind: "bound" | "idempotent"; record: DanceAttemptSessionRecord }> {
  return withTransaction(input.client, "write", async (tx) => {
    const row = await selectSessionForUpdate(tx, input.sessionId)
    if (!row) throw notFoundError("Dance attempt session not found")
    const existing = toRecord(row)
    if (existing.subjectUserId !== input.subjectUserId) {
      throw notFoundError("Dance attempt session not found")
    }
    if (existing.status === "uploading") {
      if (
        existing.uploadObjectKey !== input.objectKey
        || existing.maximumBytes !== input.sizeBytes
      ) {
        throw conflictError("Dance attempt upload intent is already bound")
      }
      return { kind: "idempotent", record: existing }
    }
    if (existing.status !== "initialized") {
      throw conflictError("Dance attempt session cannot accept an upload intent")
    }
    await tx.execute({
      sql: `
        UPDATE dance_attempt_sessions
        SET status = 'uploading', upload_object_key = ?2,
          maximum_bytes = ?3, updated_at = ?4
        WHERE dance_attempt_session_id = ?1
      `,
      args: [input.sessionId, input.objectKey, input.sizeBytes, input.now],
    })
    const updated = await selectSessionForUpdate(tx, input.sessionId)
    if (!updated) throw internalError("Bound dance attempt session is missing")
    return { kind: "bound", record: toRecord(updated) }
  })
}

export async function submitDanceAttemptSession(input: {
  client: Client
  sessionId: string
  subjectUserId: string
  contentSha256: string
  sizeBytes: number
  etag: string
  now: string
}): Promise<{ kind: "submitted" | "idempotent"; record: DanceAttemptSessionRecord }> {
  return withTransaction(input.client, "write", async (tx) => {
    const row = await selectSessionForUpdate(tx, input.sessionId)
    if (!row) throw notFoundError("Dance attempt session not found")
    const existing = toRecord(row)
    if (existing.subjectUserId !== input.subjectUserId) {
      throw notFoundError("Dance attempt session not found")
    }
    if (existing.status === "submitted" || existing.status === "grading") {
      if (
        existing.observedContentSha256 !== input.contentSha256
        || existing.observedSizeBytes !== input.sizeBytes
        || existing.observedEtag !== input.etag
      ) {
        throw conflictError("Dance attempt submission does not match")
      }
      return { kind: "idempotent", record: existing }
    }
    if (
      existing.status !== "uploading"
      || existing.maximumBytes !== input.sizeBytes
    ) {
      throw conflictError("Dance attempt session is not ready for submission")
    }
    await tx.execute({
      sql: `
        UPDATE dance_attempt_sessions
        SET status = 'submitted', observed_size_bytes = ?2,
          observed_etag = ?3, observed_content_sha256 = ?4,
          capture_mode = 'in_app_camera', submitted_at = ?5,
          grading_next_dispatch_at = ?5, cleanup_status = 'pending',
          cleanup_next_attempt_at = ?5, updated_at = ?5
        WHERE dance_attempt_session_id = ?1
      `,
      args: [
        input.sessionId,
        input.sizeBytes,
        input.etag,
        input.contentSha256,
        input.now,
      ],
    })
    const updated = await selectSessionForUpdate(tx, input.sessionId)
    if (!updated) throw internalError("Submitted dance attempt session is missing")
    return { kind: "submitted", record: toRecord(updated) }
  })
}
