import type { Env } from "../../../env"
import { getControlPlaneClient, isPostgresControlPlaneUrl } from "../../runtime-deps"
import { openCommunityWriteClient } from "../community-read-access"
import { resolveBookingAvailability } from "./booking-availability-service"

type CommunityRepository = Parameters<typeof openCommunityWriteClient>[1]

const HOLD_TTL_SECONDS = 600

export interface CreateBookingHoldInput {
  env: Env
  communityRepository: CommunityRepository
  communityId: string
  hostUserId: string
  bookerUserId: string
  slotStartUtc: string
  slotEndUtc: string
  nowUtc: string
}

export interface BookingHold {
  hold_id: string
  community_id: string
  host_user_id: string
  booker_user_id: string
  slot_start_utc: string
  slot_end_utc: string
  price_cents: number
  status: "active"
  expires_at_utc: string
}

export type CreateBookingHoldResult =
  | { ok: false; reason: "slot_unavailable" | "slot_locked" | "hold_insert_failed" }
  | { ok: true; hold: BookingHold }

// Dialect seam: the cross-community lock uses a Postgres advisory lock to serialize
// per-host acquisitions. SQLite (tests) has no pg_advisory_xact_lock — there we skip the
// advisory call but STILL run the overlap-scan + insert inside one transaction. SQLite tests
// therefore prove behavior (overlap rejection, compensation), NOT true concurrent race safety.
export function bookingLockUsesAdvisory(env: Env): boolean {
  const url = env.CONTROL_PLANE_DATABASE_URL
  return typeof url === "string" && isPostgresControlPlaneUrl(url)
}

async function releaseHostSlotLock(env: Env, lockId: string, nowUtc: string): Promise<void> {
  await getControlPlaneClient(env).execute({
    sql: `UPDATE booking_host_slot_locks SET status = 'released', updated_at = ?2 WHERE lock_id = ?1`,
    args: [lockId, nowUtc],
  })
}

export async function createBookingHold(input: CreateBookingHoldInput): Promise<CreateBookingHoldResult> {
  // 1) Validate the requested slot against the same read path: it must be a real, currently
  // available slot (this also catches same-community holds/bookings as busy). Window is the
  // slot itself; resolveSlots end is exclusive so the single slot is included.
  const availability = await resolveBookingAvailability({
    env: input.env,
    communityRepository: input.communityRepository,
    communityId: input.communityId,
    hostUserId: input.hostUserId,
    windowStartUtc: input.slotStartUtc,
    windowEndUtc: input.slotEndUtc,
    viewerTimezone: "UTC",
    nowUtc: input.nowUtc,
  })
  if (!availability.bookable) return { ok: false, reason: "slot_unavailable" }
  const slot = availability.slots.find(
    (s) => s.startUtc === input.slotStartUtc && s.endUtc === input.slotEndUtc && s.available,
  )
  if (!slot) return { ok: false, reason: "slot_unavailable" }

  const holdId = `hld_${crypto.randomUUID()}`
  const lockId = `blk_${crypto.randomUUID()}`
  const expiresAtUtc = new Date(Date.parse(input.nowUtc) + HOLD_TTL_SECONDS * 1000).toISOString()

  // 2) Acquire the cross-community lock in ONE control-plane transaction: advisory lock (PG)
  // → interval-overlap scan → insert. The committed row is the durable guard.
  const cp = getControlPlaneClient(input.env)
  const tx = await cp.transaction("write")
  try {
    if (bookingLockUsesAdvisory(input.env)) {
      await tx.execute({
        sql: "SELECT pg_advisory_xact_lock(hashtextextended(?1, 0))",
        args: [input.hostUserId],
      })
    }
    // Self-heal: release any of this host's lapsed-but-still-'active' locks before scanning.
    // The release/sweep job may lag; without this an expired lock would block the slot forever.
    await tx.execute({
      sql: `UPDATE booking_host_slot_locks
            SET status = 'released', updated_at = ?2
            WHERE host_user_id = ?1 AND status = 'active'
              AND expires_at_utc IS NOT NULL AND expires_at_utc <= ?2`,
      args: [input.hostUserId, input.nowUtc],
    })
    const overlap = await tx.execute({
      sql: `SELECT lock_id FROM booking_host_slot_locks
            WHERE host_user_id = ?1 AND status = 'active'
              AND slot_start_utc < ?2 AND slot_end_utc > ?3
            LIMIT 1`,
      args: [input.hostUserId, input.slotEndUtc, input.slotStartUtc],
    })
    if (overlap.rows.length > 0) {
      await tx.rollback()
      return { ok: false, reason: "slot_locked" }
    }
    await tx.execute({
      sql: `INSERT INTO booking_host_slot_locks (
              lock_id, host_user_id, slot_start_utc, slot_end_utc, community_id, hold_id, booking_id,
              status, expires_at_utc, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, 'active', ?7, ?8, ?8)`,
      args: [lockId, input.hostUserId, input.slotStartUtc, input.slotEndUtc, input.communityId, holdId, expiresAtUtc, input.nowUtc],
    })
    await tx.commit()
  } catch (error) {
    try { await tx.rollback() } catch { /* already settled */ }
    throw error
  } finally {
    tx.close()
  }

  // 3) Insert the per-community hold (D1). On failure, RELEASE the cross-community lock so the
  // slot can be retried — the lock-first / compensate-on-failure contract from migration 0120.
  try {
    const write = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
    try {
      await write.client.execute({
        sql: `INSERT INTO booking_holds (
                hold_id, community_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc,
                price_cents, status, expires_at_utc, created_at, updated_at
              ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', ?8, ?9, ?9)`,
        args: [holdId, input.communityId, input.hostUserId, input.bookerUserId, input.slotStartUtc, input.slotEndUtc, slot.priceCents, expiresAtUtc, input.nowUtc],
      })
    } finally {
      write.close()
    }
  } catch {
    await releaseHostSlotLock(input.env, lockId, input.nowUtc)
    return { ok: false, reason: "hold_insert_failed" }
  }

  return {
    ok: true,
    hold: {
      hold_id: holdId,
      community_id: input.communityId,
      host_user_id: input.hostUserId,
      booker_user_id: input.bookerUserId,
      slot_start_utc: input.slotStartUtc,
      slot_end_utc: input.slotEndUtc,
      price_cents: slot.priceCents,
      status: "active",
      expires_at_utc: expiresAtUtc,
    },
  }
}
