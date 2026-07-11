import { DurableObject } from "cloudflare:workers"

import type { Env } from "../env"
import { evaluateLease, SCHEDULED_CRON_LOCK_NAME, type LeaseRecord } from "./scheduled-cron-lease"
import type { CronLock } from "./scheduled-job-runner"

/**
 * Durable-Object-backed lease that guarantees only ONE scheduled (cron) batch runs
 * at a time across the whole deployment — chosen over a Postgres advisory lock
 * (which would spend a scarce control-plane connection) or a lease row (which
 * would need a control-plane migration). Coordination state belongs in a DO.
 *
 * A single deterministic instance (`getByName("scheduled-cron-main")`) is the
 * arbiter. Leases self-expire by timestamp, so a crashed/killed batch that never
 * calls `release` cannot deadlock future invocations. Pure lease semantics live in
 * `scheduled-cron-lease.ts` (`evaluateLease`); this class is a thin SQLite wrapper.
 */
export class ScheduledCronLockDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, expires_at INTEGER NOT NULL)",
      )
    })
  }

  /**
   * Atomically acquires the lease if free or expired (or already owned). The read
   * and write are SYNCHRONOUS `sql.exec` with no `await` between them, so no other
   * request to this DO can interleave — the read-modify-write is atomic.
   */
  tryAcquire(ttlMs: number, owner: string, now: number): boolean {
    const decision = evaluateLease(this.readLease(), ttlMs, owner, now)
    if (decision.acquired && decision.lease) {
      this.ctx.storage.sql.exec(
        "INSERT INTO lease (id, owner, expires_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at",
        decision.lease.owner,
        decision.lease.expiresAt,
      )
    }
    return decision.acquired
  }

  /** Releases the lease only if still held by `owner` (never clobbers a newer holder). */
  release(owner: string): void {
    this.ctx.storage.sql.exec("DELETE FROM lease WHERE id = 1 AND owner = ?", owner)
  }

  private readLease(): LeaseRecord | null {
    const rows = this.ctx.storage.sql
      .exec<{ owner: string; expires_at: number }>("SELECT owner, expires_at FROM lease WHERE id = 1")
      .toArray()
    const row = rows[0]
    return row ? { expiresAt: Number(row.expires_at), owner: row.owner } : null
  }
}

/** Adapts the singleton DO into the {@link CronLock} the scheduler consumes. */
export function createDurableObjectCronLock(
  namespace: DurableObjectNamespace<ScheduledCronLockDO>,
  name: string = SCHEDULED_CRON_LOCK_NAME,
): CronLock {
  const stub = namespace.getByName(name)
  return {
    release: (owner) => Promise.resolve(stub.release(owner)),
    tryAcquire: (ttlMs, owner, now) => Promise.resolve(stub.tryAcquire(ttlMs, owner, now)),
  }
}
