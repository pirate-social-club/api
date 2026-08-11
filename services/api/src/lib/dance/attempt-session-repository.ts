import { executeFirst } from "../db-helpers"
import { conflictError, internalError, notFoundError, rateLimited } from "../errors"
import { rowValue, stringOrNull } from "../sql-row"
import type { Client, Transaction } from "../sql-client"
import { withTransaction } from "../transactions"
import { danceAttemptPlaceholderObjectKey } from "./attempt-object-key"

export const DANCE_ATTEMPT_MAX_BYTES = 19_000_000
export const DANCE_CONSENT_POLICY_VERSION = "dance_recording_v1"
export const DANCE_ATTEMPT_CALIBRATION_VERSION =
  "dance_calibration_gate0_provisional_v1"
export const DANCE_ATTEMPT_CALIBRATION_CHECKSUM =
  "9bbccca0bc17aab7d65faf7f29a4d4cac110c64473168017610b5f050c3fa50a"
export const DANCE_ATTEMPT_FINGERPRINT_POLICY_VERSION =
  "dance_motion_fingerprint_gate0_v1"
export const DANCE_ATTEMPT_INTEGRITY_POLICY_VERSION =
  "dance_integrity_gate0_v1"
export const DANCE_SCORER_VERSION = "dance_scorer_gate0_v2"
export const DANCE_START_CUE_POLICY_VERSION = "dance_start_cue_gross_body_v1"
export const DANCE_START_CUE_MINIMUM_HOLD_MS = 500
export const DANCE_START_CUE_OBSERVATION_WINDOW_MS = 2500
export const DANCE_SESSION_CREATION_LIMIT_PER_HOUR = 6
export const DANCE_START_CUE_KINDS = [
  "hands_on_head",
  "arms_t",
  "hands_on_hips",
] as const
export type DanceStartCueKind = typeof DANCE_START_CUE_KINDS[number]

export type DanceAttemptSessionRecord = {
  sessionId: string
  attemptId: string
  subjectUserId: string
  communityId: string
  hostPostId: string
  referencedSongPostId: string
  choreographyId: string
  choreographyRevisionId: string
  status: string
  uploadObjectKey: string
  maximumBytes: number
  observedSizeBytes: number | null
  observedEtag: string | null
  observedContentSha256: string | null
  terminalReason: string | null
  scoreBps: number | null
  calibrationAdmitted: boolean | null
  consentPolicyVersion: string | null
  consentedAt: string | null
  consentSource: string | null
  startCuePolicyVersion?: string | null
  startCueKind?: string | null
  startCueMinimumHoldMs?: number | null
  startCueObservationWindowMs?: number | null
  expiresAt: string
  submittedAt: string | null
  finalizedAt: string | null
  createdAt: string
}

export type CreateDanceAttemptSessionInput = {
  sessionId: string
  attemptId: string
  subjectUserId: string
  hostPostId: string
  creationIdempotencyKey: string
  activityDate: string
  activityTimezone: string
  consentPolicyVersion: typeof DANCE_CONSENT_POLICY_VERSION
  consentedAt: string
  consentSource: "api" | "telegram" | "ios" | "android"
  startCueKind?: DanceStartCueKind
  now: string
  expiresAt: string
}

const SESSION_SELECT = `
  SELECT dance_attempt_session_id, dance_attempt_id, subject_user_id, community_id,
    host_post_id, referenced_song_post_id, dance_choreography_id,
    dance_choreography_revision_id, status, upload_object_key, maximum_bytes,
    observed_size_bytes, observed_etag, observed_content_sha256, terminal_reason,
    score_bps, calibration_admitted, consent_policy_version, consented_at,
    consent_source, start_cue_policy_version, start_cue_kind,
    start_cue_minimum_hold_ms, start_cue_observation_window_ms,
    expires_at, submitted_at, finalized_at, created_at
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

function nullableBoolean(row: unknown, field: string): boolean | null {
  const value = nullableNumber(row, field)
  if (value === null) return null
  if (value !== 0 && value !== 1) {
    throw internalError(`Dance attempt session has invalid ${field}`)
  }
  return value === 1
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
    communityId: requiredString(row, "community_id"),
    hostPostId: requiredString(row, "host_post_id"),
    referencedSongPostId: requiredString(row, "referenced_song_post_id"),
    choreographyId: requiredString(row, "dance_choreography_id"),
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
    terminalReason: stringOrNull(rowValue(row, "terminal_reason")),
    scoreBps: nullableNumber(row, "score_bps"),
    calibrationAdmitted: nullableBoolean(row, "calibration_admitted"),
    consentPolicyVersion: stringOrNull(rowValue(row, "consent_policy_version")),
    consentedAt: stringOrNull(rowValue(row, "consented_at")),
    consentSource: stringOrNull(rowValue(row, "consent_source")),
    startCuePolicyVersion: stringOrNull(rowValue(row, "start_cue_policy_version")),
    startCueKind: stringOrNull(rowValue(row, "start_cue_kind")),
    startCueMinimumHoldMs: nullableNumber(row, "start_cue_minimum_hold_ms"),
    startCueObservationWindowMs: nullableNumber(row, "start_cue_observation_window_ms"),
    expiresAt: requiredString(row, "expires_at"),
    submittedAt: stringOrNull(rowValue(row, "submitted_at")),
    finalizedAt: stringOrNull(rowValue(row, "finalized_at")),
    createdAt: requiredString(row, "created_at"),
  }
}

function assertRecordingConsent(record: DanceAttemptSessionRecord): void {
  if (
    record.consentPolicyVersion !== DANCE_CONSENT_POLICY_VERSION
    || !record.consentedAt
    || !["api", "telegram", "ios", "android"].includes(record.consentSource ?? "")
  ) {
    throw conflictError("Dance recording consent is missing")
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

export async function getDanceAttemptSessionByAttemptId(input: {
  client: Client
  attemptId: string
  subjectUserId: string
}): Promise<DanceAttemptSessionRecord | null> {
  const row = await executeFirst(input.client, {
    sql: `${SESSION_SELECT}
      WHERE dance_attempt_id = ?1 AND subject_user_id = ?2`,
    args: [input.attemptId, input.subjectUserId],
  })
  return row ? toRecord(row) : null
}

export async function cancelDanceAttemptSession(input: {
  client: Client
  sessionId: string
  subjectUserId: string
  now: string
}): Promise<{ kind: "cancelled" | "idempotent"; record: DanceAttemptSessionRecord }> {
  return withTransaction(input.client, "write", async (tx) => {
    const row = await selectSessionForUpdate(tx, input.sessionId)
    if (!row) throw notFoundError("Dance attempt session not found")
    const existing = toRecord(row)
    if (existing.subjectUserId !== input.subjectUserId) {
      throw notFoundError("Dance attempt session not found")
    }
    if (["cancelled", "expired", "finalized", "rejected", "failed"].includes(existing.status)) {
      return { kind: "idempotent", record: existing }
    }
    if (existing.status !== "initialized" && existing.status !== "uploading") {
      throw conflictError("Submitted dance session cannot be cancelled")
    }
    const cleanupRequired = existing.uploadObjectKey
      !== danceAttemptPlaceholderObjectKey(existing.sessionId)
    await tx.execute({
      sql: `
        UPDATE dance_attempt_sessions
        SET status = 'cancelled', terminal_reason = 'cancelled',
          finalized_at = ?2, cleanup_status = ?3,
          cleanup_next_attempt_at = ?4, updated_at = ?2
        WHERE dance_attempt_session_id = ?1
      `,
      args: [
        input.sessionId,
        input.now,
        cleanupRequired ? "pending" : "not_required",
        cleanupRequired ? input.now : null,
      ],
    })
    const updated = await selectSessionForUpdate(tx, input.sessionId)
    if (!updated) throw internalError("Cancelled dance attempt session is missing")
    return { kind: "cancelled", record: toRecord(updated) }
  })
}

export async function createDanceAttemptSession(input: {
  client: Client
  value: CreateDanceAttemptSessionInput
}): Promise<{ kind: "created" | "idempotent"; record: DanceAttemptSessionRecord }> {
  return withTransaction(input.client, "write", async (tx) => {
    const value = input.value
    const budget = await executeFirst(tx, {
      sql: `
        SELECT
          COUNT(*) FILTER (WHERE created_at >= ?2::timestamptz - INTERVAL '1 hour') AS recent_count,
          COUNT(*) FILTER (WHERE status IN ('initialized', 'uploading', 'submitted', 'grading')) AS active_count,
          COUNT(*) FILTER (WHERE creation_idempotency_key = ?3) AS idempotency_count
        FROM dance_attempt_sessions
        WHERE subject_user_id = ?1
      `,
      args: [value.subjectUserId, value.now, value.creationIdempotencyKey],
    })
    const idempotencyCount = Number(rowValue(budget, "idempotency_count") ?? 0)
    if (idempotencyCount === 0) {
      if (Number(rowValue(budget, "active_count") ?? 0) > 0) {
        throw conflictError("An active dance session already exists")
      }
      if (Number(rowValue(budget, "recent_count") ?? 0) >= DANCE_SESSION_CREATION_LIMIT_PER_HOUR) {
        throw rateLimited("Dance session creation limit reached")
      }
    }
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
          AND r.scorer_version = ?2
        FOR UPDATE
      `,
      args: [value.hostPostId, DANCE_SCORER_VERSION],
    })
    if (!revision) throw notFoundError("Active dance choreography revision not found")

    const placeholderKey = danceAttemptPlaceholderObjectKey(value.sessionId)
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
          creation_idempotency_key, consent_policy_version, consented_at,
          consent_source, start_cue_policy_version, start_cue_kind,
          start_cue_minimum_hold_ms, start_cue_observation_window_ms,
          upload_object_key, expected_mime_type,
          maximum_bytes, expires_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13,
          ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23,
          'initialized', ?24, ?25, ?26, ?27, ?28, ?29,
          ?30, ?31, ?32, ?33, ?34,
          'video/mp4', ?35, ?36, ?37, ?37
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
        value.consentPolicyVersion,
        value.consentedAt,
        value.consentSource,
        DANCE_START_CUE_POLICY_VERSION,
        value.startCueKind ?? "hands_on_head",
        DANCE_START_CUE_MINIMUM_HOLD_MS,
        DANCE_START_CUE_OBSERVATION_WINDOW_MS,
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
      || record.consentPolicyVersion !== value.consentPolicyVersion
      || record.consentSource !== value.consentSource
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
    assertRecordingConsent(existing)
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
    assertRecordingConsent(existing)
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
