import type { Client, Transaction } from "../sql-client"
import { conflictError } from "../errors"

export type HnsImportRestartAttempt = {
  challengeTxtValue: string
  token: string
}

export async function reserveHnsImportSessionLock(
  client: Client,
  input: {
    normalizedRootLabel: string
    sessionId: string
    userId: string
    expiresAt: string
    now: string
  },
): Promise<void> {
  // An active same-session lock is preserved until restart succeeds. This
  // prevents a verifier contract failure from extending its ownership lease.
  // An expired lock must be reacquired before any external publish so another
  // session cannot take the root mid-attempt; that session remains retryable.
  const result = await client.execute({
    sql: `
      INSERT INTO hns_import_session_locks (
        normalized_root_label, namespace_verification_session_id, user_id,
        expires_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
      ON CONFLICT (normalized_root_label) DO UPDATE SET
        namespace_verification_session_id = EXCLUDED.namespace_verification_session_id,
        user_id = EXCLUDED.user_id,
        expires_at = CASE
          WHEN hns_import_session_locks.namespace_verification_session_id = ?2
            AND hns_import_session_locks.expires_at > ?5
            THEN hns_import_session_locks.expires_at
          ELSE EXCLUDED.expires_at
        END,
        created_at = CASE
          WHEN hns_import_session_locks.namespace_verification_session_id = ?2
            THEN hns_import_session_locks.created_at
          ELSE EXCLUDED.created_at
        END,
        updated_at = EXCLUDED.updated_at
      WHERE hns_import_session_locks.expires_at <= ?5
         OR hns_import_session_locks.namespace_verification_session_id = ?2
      RETURNING namespace_verification_session_id
    `,
    args: [
      input.normalizedRootLabel,
      input.sessionId,
      input.userId,
      input.expiresAt,
      input.now,
    ],
  })
  if (result.rows.length !== 1) {
    throw conflictError("A Handshake import is already active for this root", {
      root_label: input.normalizedRootLabel,
    })
  }
}

export async function acquireHnsImportRestartAttempt(
  client: Client,
  input: {
    normalizedRootLabel: string
    sessionId: string
    token: string
    challengeTxtValue: string
    expiresAt: string
    now: string
  },
): Promise<HnsImportRestartAttempt> {
  const result = await client.execute({
    sql: `
      UPDATE hns_import_session_locks
      SET restart_attempt_token = ?3,
          restart_challenge_txt_value = COALESCE(restart_challenge_txt_value, ?4),
          restart_attempt_expires_at = ?5,
          updated_at = ?6
      WHERE normalized_root_label = ?1
        AND namespace_verification_session_id = ?2
        AND (
          restart_attempt_token IS NULL
          OR restart_attempt_expires_at <= ?6
        )
      RETURNING restart_attempt_token, restart_challenge_txt_value
    `,
    args: [
      input.normalizedRootLabel,
      input.sessionId,
      input.token,
      input.challengeTxtValue,
      input.expiresAt,
      input.now,
    ],
  })
  const row = result.rows[0]
  if (result.rows.length !== 1
    || typeof row?.restart_attempt_token !== "string"
    || typeof row.restart_challenge_txt_value !== "string") {
    throw conflictError("A Handshake import restart is already in progress", {
      root_label: input.normalizedRootLabel,
    })
  }
  return {
    challengeTxtValue: row.restart_challenge_txt_value,
    token: row.restart_attempt_token,
  }
}

export async function releaseHnsImportRestartAttempt(
  client: Client,
  input: {
    normalizedRootLabel: string
    sessionId: string
    token: string
  },
): Promise<void> {
  await client.execute({
    sql: `
      UPDATE hns_import_session_locks
      SET restart_attempt_token = NULL,
          restart_challenge_txt_value = NULL,
          restart_attempt_expires_at = NULL
      WHERE normalized_root_label = ?1
        AND namespace_verification_session_id = ?2
        AND restart_attempt_token = ?3
    `,
    args: [input.normalizedRootLabel, input.sessionId, input.token],
  })
}

export async function completeHnsImportRestartAttempt(
  executor: Pick<Client | Transaction, "execute">,
  input: {
    normalizedRootLabel: string
    sessionId: string
    token: string
    sessionExpiresAt: string
  },
): Promise<void> {
  const result = await executor.execute({
    sql: `
      UPDATE hns_import_session_locks
      SET restart_attempt_token = NULL,
          restart_challenge_txt_value = NULL,
          restart_attempt_expires_at = NULL,
          expires_at = ?4
      WHERE normalized_root_label = ?1
        AND namespace_verification_session_id = ?2
        AND restart_attempt_token = ?3
    `,
    args: [
      input.normalizedRootLabel,
      input.sessionId,
      input.token,
      input.sessionExpiresAt,
    ],
  })
  if (result.rowsAffected !== 1) {
    throw conflictError("Handshake import restart lost its finalization lease")
  }
}

export async function releaseHnsImportSessionLock(
  client: Client,
  input: { normalizedRootLabel: string; sessionId: string },
): Promise<void> {
  await client.execute({
    sql: `
      DELETE FROM hns_import_session_locks
      WHERE normalized_root_label = ?1
        AND namespace_verification_session_id = ?2
    `,
    args: [input.normalizedRootLabel, input.sessionId],
  })
}
