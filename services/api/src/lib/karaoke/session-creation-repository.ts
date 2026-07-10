import { executeFirst } from "../db-helpers"
import { internalError } from "../errors"
import { numberOrNull, rowValue, stringOrNull } from "../sql-row"
import type { Client } from "../sql-client"

type KaraokeSessionCreationStatus = "pending" | "initialized" | "failed"

export interface KaraokeSessionCreationKey {
  subjectUserId: string
  communityId: string
  postId: string
  idempotencyKey: string
}

export interface KaraokeSessionCreationRecord extends KaraokeSessionCreationKey {
  status: KaraokeSessionCreationStatus
  sessionId: string | null
  attemptId: string | null
  websocketBaseUrl: string | null
  protocolVersion: number | null
  scoringPolicyJson: string | null
  sessionExpiresAt: string | null
  tokenIssuedAt: number | null
  tokenExpiresAt: number | null
  tokenNonce: string | null
  failureCode: string | null
  createdAt: string
  updatedAt: string
  expiresAt: string
}

export type ClaimKaraokeSessionCreationResult =
  | { kind: "claimed"; record: KaraokeSessionCreationRecord }
  | { kind: "initialized"; record: KaraokeSessionCreationRecord }
  | { kind: "pending"; record: KaraokeSessionCreationRecord }

export type RotateKaraokeGatewayClaimsResult =
  | { kind: "rotated"; record: KaraokeSessionCreationRecord }
  | { kind: "concurrent"; record: KaraokeSessionCreationRecord }

const COLUMNS = `
  subject_user_id, community_id, post_id, idempotency_key, status,
  session_id, attempt_id, websocket_base_url, protocol_version, scoring_policy_json,
  session_expires_at, token_issued_at, token_expires_at, token_nonce, failure_code,
  created_at, updated_at, expires_at
`

function parseStatus(value: unknown): KaraokeSessionCreationStatus {
  if (value === "pending" || value === "initialized" || value === "failed") return value
  throw internalError("Karaoke session creation record has invalid status")
}

function toRecord(row: unknown): KaraokeSessionCreationRecord {
  if (!row || typeof row !== "object") {
    throw internalError("Karaoke session creation record is missing")
  }
  const required = (field: string): string => {
    const value = stringOrNull(rowValue(row, field))
    if (!value) throw internalError(`Karaoke session creation record is missing ${field}`)
    return value
  }
  return {
    attemptId: stringOrNull(rowValue(row, "attempt_id")),
    communityId: required("community_id"),
    createdAt: required("created_at"),
    expiresAt: required("expires_at"),
    failureCode: stringOrNull(rowValue(row, "failure_code")),
    idempotencyKey: required("idempotency_key"),
    postId: required("post_id"),
    protocolVersion: numberOrNull(rowValue(row, "protocol_version")),
    scoringPolicyJson: stringOrNull(rowValue(row, "scoring_policy_json")),
    sessionExpiresAt: stringOrNull(rowValue(row, "session_expires_at")),
    sessionId: stringOrNull(rowValue(row, "session_id")),
    status: parseStatus(rowValue(row, "status")),
    subjectUserId: required("subject_user_id"),
    tokenExpiresAt: numberOrNull(rowValue(row, "token_expires_at")),
    tokenIssuedAt: numberOrNull(rowValue(row, "token_issued_at")),
    tokenNonce: stringOrNull(rowValue(row, "token_nonce")),
    updatedAt: required("updated_at"),
    websocketBaseUrl: stringOrNull(rowValue(row, "websocket_base_url")),
  }
}

export async function getKaraokeSessionCreationRecord(input: {
  client: Client
  key: KaraokeSessionCreationKey
}): Promise<KaraokeSessionCreationRecord | null> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT ${COLUMNS}
      FROM karaoke_session_creation_requests
      WHERE subject_user_id = ?1
        AND community_id = ?2
        AND post_id = ?3
        AND idempotency_key = ?4
      LIMIT 1
    `,
    args: [
      input.key.subjectUserId,
      input.key.communityId,
      input.key.postId,
      input.key.idempotencyKey,
    ],
  })
  return row ? toRecord(row) : null
}

export async function claimKaraokeSessionCreation(input: {
  client: Client
  key: KaraokeSessionCreationKey
  now: string
  pendingExpiresAt: string
}): Promise<ClaimKaraokeSessionCreationResult> {
  const insert = await input.client.execute({
    sql: `
      INSERT OR IGNORE INTO karaoke_session_creation_requests (
        subject_user_id, community_id, post_id, idempotency_key, status,
        created_at, updated_at, expires_at
      ) VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?5, ?6)
    `,
    args: [
      input.key.subjectUserId,
      input.key.communityId,
      input.key.postId,
      input.key.idempotencyKey,
      input.now,
      input.pendingExpiresAt,
    ],
  })

  let record = await getKaraokeSessionCreationRecord({ client: input.client, key: input.key })
  if (!record) throw internalError("Karaoke session creation claim was not persisted")
  if ((insert.rowsAffected ?? 0) > 0) {
    return { kind: "claimed", record }
  }
  if (record.status === "initialized" && record.expiresAt > input.now) {
    return { kind: "initialized", record }
  }
  if (record.status === "pending" && record.expiresAt > input.now) {
    return { kind: "pending", record }
  }
  if (record.status !== "pending" || record.expiresAt <= input.now) {
    await input.client.execute({
      sql: `
        UPDATE karaoke_session_creation_requests
        SET status = 'pending', session_id = NULL, attempt_id = NULL,
            websocket_base_url = NULL, protocol_version = NULL, scoring_policy_json = NULL,
            session_expires_at = NULL, token_issued_at = NULL, token_expires_at = NULL,
            token_nonce = NULL, failure_code = NULL, updated_at = ?5, expires_at = ?6
        WHERE subject_user_id = ?1 AND community_id = ?2 AND post_id = ?3 AND idempotency_key = ?4
      `,
      args: [
        input.key.subjectUserId,
        input.key.communityId,
        input.key.postId,
        input.key.idempotencyKey,
        input.now,
        input.pendingExpiresAt,
      ],
    })
    record = await getKaraokeSessionCreationRecord({ client: input.client, key: input.key })
    if (!record) throw internalError("Karaoke session creation claim could not be reclaimed")
  }
  return { kind: "claimed", record }
}

export async function finalizeKaraokeSessionCreation(input: {
  client: Client
  key: KaraokeSessionCreationKey
  sessionId: string
  attemptId: string
  websocketBaseUrl: string
  protocolVersion: number
  scoringPolicyJson: string
  sessionExpiresAt: string
  tokenIssuedAt: number
  tokenExpiresAt: number
  tokenNonce: string
  now: string
}): Promise<KaraokeSessionCreationRecord> {
  await input.client.execute({
    sql: `
      UPDATE karaoke_session_creation_requests
      SET status = 'initialized', session_id = ?5, attempt_id = ?6,
          websocket_base_url = ?7, protocol_version = ?8, scoring_policy_json = ?9,
          session_expires_at = ?10, token_issued_at = ?11, token_expires_at = ?12,
          token_nonce = ?13, failure_code = NULL, updated_at = ?14, expires_at = ?10
      WHERE subject_user_id = ?1 AND community_id = ?2 AND post_id = ?3
        AND idempotency_key = ?4 AND status = 'pending'
    `,
    args: [
      input.key.subjectUserId,
      input.key.communityId,
      input.key.postId,
      input.key.idempotencyKey,
      input.sessionId,
      input.attemptId,
      input.websocketBaseUrl,
      input.protocolVersion,
      input.scoringPolicyJson,
      input.sessionExpiresAt,
      input.tokenIssuedAt,
      input.tokenExpiresAt,
      input.tokenNonce,
      input.now,
    ],
  })
  const record = await getKaraokeSessionCreationRecord({ client: input.client, key: input.key })
  if (!record || record.status !== "initialized") {
    throw internalError("Karaoke session creation could not be finalized")
  }
  return record
}

export async function failKaraokeSessionCreation(input: {
  client: Client
  key: KaraokeSessionCreationKey
  failureCode: string
  now: string
  expiresAt: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE karaoke_session_creation_requests
      SET status = 'failed', failure_code = ?5, updated_at = ?6, expires_at = ?7
      WHERE subject_user_id = ?1 AND community_id = ?2 AND post_id = ?3
        AND idempotency_key = ?4 AND status = 'pending'
    `,
    args: [
      input.key.subjectUserId,
      input.key.communityId,
      input.key.postId,
      input.key.idempotencyKey,
      input.failureCode,
      input.now,
      input.expiresAt,
    ],
  })
}

export async function rotateKaraokeGatewayClaims(input: {
  client: Client
  key: KaraokeSessionCreationKey
  previousTokenExpiresAt: number
  tokenIssuedAt: number
  tokenExpiresAt: number
  tokenNonce: string
  now: string
}): Promise<RotateKaraokeGatewayClaimsResult> {
  const result = await input.client.execute({
    sql: `
      UPDATE karaoke_session_creation_requests
      SET token_issued_at = ?5, token_expires_at = ?6, token_nonce = ?7, updated_at = ?8
      WHERE subject_user_id = ?1 AND community_id = ?2 AND post_id = ?3
        AND idempotency_key = ?4 AND status = 'initialized' AND token_expires_at = ?9
    `,
    args: [
      input.key.subjectUserId,
      input.key.communityId,
      input.key.postId,
      input.key.idempotencyKey,
      input.tokenIssuedAt,
      input.tokenExpiresAt,
      input.tokenNonce,
      input.now,
      input.previousTokenExpiresAt,
    ],
  })
  const record = await getKaraokeSessionCreationRecord({ client: input.client, key: input.key })
  if (!record || record.status !== "initialized") {
    throw internalError("Karaoke gateway claims could not be rotated")
  }
  if (
    (result.rowsAffected ?? 0) === 0
    || record.tokenIssuedAt !== input.tokenIssuedAt
    || record.tokenExpiresAt !== input.tokenExpiresAt
    || record.tokenNonce !== input.tokenNonce
  ) {
    return { kind: "concurrent", record }
  }
  return { kind: "rotated", record }
}
