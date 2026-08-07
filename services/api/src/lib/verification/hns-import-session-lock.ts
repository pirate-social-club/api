import type { Client } from "../sql-client"
import { conflictError } from "../errors"

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
  const result = await client.execute({
    sql: `
      INSERT INTO hns_import_session_locks (
        normalized_root_label, namespace_verification_session_id, user_id,
        expires_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?5)
      ON CONFLICT (normalized_root_label) DO UPDATE SET
        namespace_verification_session_id = EXCLUDED.namespace_verification_session_id,
        user_id = EXCLUDED.user_id,
        expires_at = EXCLUDED.expires_at,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at
      WHERE hns_import_session_locks.expires_at <= ?5
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
