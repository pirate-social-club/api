import type { Env } from "../../env"
import { executeFirst } from "../db-helpers"
import { getControlPlaneClient } from "../runtime-deps"
import { rowValue, stringOrNull } from "../sql-row"
import type { Client } from "../sql-client"
import { withTransaction } from "../transactions"
import { deleteDanceAttemptUpload } from "./attempt-storage"

const MAX_CLEANUPS_PER_SWEEP = 10
const CLAIM_TTL_MS = 2 * 60_000

function retryDelayMs(attempt: number): number {
  return [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000][
    Math.max(0, Math.min(attempt - 1, 3))
  ]
}

async function claimCleanup(input: {
  client: Client
  now: string
  claimUntil: string
}): Promise<{ sessionId: string; objectKey: string; attempt: number } | null> {
  return withTransaction(input.client, "write", async (tx) => {
    const row = await executeFirst(tx, {
      sql: `
        SELECT dance_attempt_session_id, upload_object_key, cleanup_attempt_count
        FROM dance_attempt_sessions
        WHERE cleanup_status IN ('pending', 'retrying')
          AND status IN ('finalized', 'rejected', 'failed', 'expired', 'cancelled')
          AND cleanup_next_attempt_at <= ?1
          AND cleanup_attempt_count < 20
        ORDER BY cleanup_next_attempt_at, created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `,
      args: [input.now],
    })
    if (!row) return null
    const sessionId = stringOrNull(rowValue(row, "dance_attempt_session_id"))
    const objectKey = stringOrNull(rowValue(row, "upload_object_key"))
    const attempt = Number(rowValue(row, "cleanup_attempt_count")) + 1
    if (!sessionId || !objectKey || !Number.isSafeInteger(attempt)) return null
    await tx.execute({
      sql: `
        UPDATE dance_attempt_sessions
        SET cleanup_status = 'retrying', cleanup_attempt_count = ?2,
          cleanup_next_attempt_at = ?3, updated_at = ?1
        WHERE dance_attempt_session_id = ?4
      `,
      args: [input.now, attempt, input.claimUntil, sessionId],
    })
    return { sessionId, objectKey, attempt }
  })
}

export async function expireDanceAttemptSessions(input: {
  client: Client
  now: string
}): Promise<number> {
  const result = await input.client.execute({
    sql: `
      UPDATE dance_attempt_sessions
      SET status = 'expired', terminal_reason = 'session_expired',
        finalized_at = ?1,
        cleanup_status = CASE
          WHEN upload_object_key =
            'dance/attempt-media/' || dance_attempt_session_id || '/pending.mp4'
          THEN 'not_required'
          ELSE 'pending'
        END,
        cleanup_next_attempt_at = CASE
          WHEN upload_object_key =
            'dance/attempt-media/' || dance_attempt_session_id || '/pending.mp4'
          THEN NULL
          ELSE ?1
        END,
        updated_at = ?1
      WHERE status IN ('initialized', 'uploading')
        AND expires_at <= ?1
    `,
    args: [input.now],
  })
  return result.rowsAffected ?? result.rows.length
}

export async function cleanupDueDanceAttempts(input: {
  env: Env
  client?: Client
  fetchFn?: typeof fetch
  now?: () => number
  maxCleanups?: number
}): Promise<{
  expired: number
  expired_fingerprints: number
  claimed: number
  deleted: number
  retry_scheduled: number
  failed: number
}> {
  const client = input.client ?? getControlPlaneClient(input.env)
  const now = input.now ?? (() => Date.now())
  const sweepNow = new Date(now()).toISOString()
  const expiredFingerprints = await client.execute({
    sql: "DELETE FROM dance_attempt_fingerprints WHERE expires_at <= ?1",
    args: [sweepNow],
  })
  const summary = {
    expired: await expireDanceAttemptSessions({
      client,
      now: sweepNow,
    }),
    expired_fingerprints:
      expiredFingerprints.rowsAffected ?? expiredFingerprints.rows.length,
    claimed: 0,
    deleted: 0,
    retry_scheduled: 0,
    failed: 0,
  }
  const limit = Math.max(
    1,
    Math.min(input.maxCleanups ?? MAX_CLEANUPS_PER_SWEEP, MAX_CLEANUPS_PER_SWEEP),
  )
  for (let index = 0; index < limit; index += 1) {
    const claimedAt = now()
    const record = await claimCleanup({
      client,
      now: new Date(claimedAt).toISOString(),
      claimUntil: new Date(claimedAt + CLAIM_TTL_MS).toISOString(),
    })
    if (!record) break
    summary.claimed += 1
    try {
      await deleteDanceAttemptUpload({
        env: input.env,
        objectKey: record.objectKey,
        fetchFn: input.fetchFn,
        now: new Date(claimedAt),
      })
      await client.execute({
        sql: `
          UPDATE dance_attempt_sessions
          SET cleanup_status = 'deleted', cleanup_next_attempt_at = NULL,
            cleanup_last_error = NULL, deleted_at = ?2, updated_at = ?2
          WHERE dance_attempt_session_id = ?1
            AND cleanup_status = 'retrying'
        `,
        args: [record.sessionId, new Date(now()).toISOString()],
      })
      summary.deleted += 1
    } catch (error) {
      const terminal = record.attempt >= 20
      await client.execute({
        sql: `
          UPDATE dance_attempt_sessions
          SET cleanup_status = ?2, cleanup_next_attempt_at = ?3,
            cleanup_last_error = ?4, updated_at = ?5
          WHERE dance_attempt_session_id = ?1
            AND cleanup_status = 'retrying'
        `,
        args: [
          record.sessionId,
          terminal ? "failed" : "retrying",
          terminal
            ? null
            : new Date(now() + retryDelayMs(record.attempt)).toISOString(),
          error instanceof Error
            ? error.message.slice(0, 200)
            : "dance_attempt_delete_unavailable",
          new Date(now()).toISOString(),
        ],
      })
      summary[terminal ? "failed" : "retry_scheduled"] += 1
    }
  }
  return summary
}
