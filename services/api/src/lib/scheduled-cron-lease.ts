/**
 * Pure lease semantics for the scheduled-cron lock — no `cloudflare:workers`
 * import, so it is unit-testable off the Durable Object. The DO
 * (`scheduled-cron-lock.ts`) is a thin SQLite-backed wrapper around `evaluateLease`.
 */
export const SCHEDULED_CRON_LOCK_NAME = "scheduled-cron-main"

export interface LeaseRecord {
  owner: string
  expiresAt: number
}

/**
 * Decides whether `owner` may hold the lease given the current record. Acquires
 * when the lease is free, expired, or already owned by the same owner (renewal);
 * denies only when held by a DIFFERENT owner and not yet expired.
 */
export function evaluateLease(
  current: LeaseRecord | null,
  ttlMs: number,
  owner: string,
  now: number,
): { acquired: boolean; lease: LeaseRecord | null } {
  const heldByOther = current !== null && current.expiresAt > now && current.owner !== owner
  if (heldByOther) return { acquired: false, lease: current }
  return { acquired: true, lease: { expiresAt: now + ttlMs, owner } }
}
