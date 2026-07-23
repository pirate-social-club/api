import type { Env } from "../../env"
import { getControlPlaneClient, withBackgroundControlPlaneClients } from "../runtime-deps"
import type { Client } from "../sql-client"
import { resolveGlobalBookingAvailability } from "./booking-hold-service"

export const BOOKING_FEED_DISCOVERY_WINDOW_DAYS = 14
export const BOOKING_FEED_DISCOVERY_TTL_MS = 10 * 60 * 1000

export interface BookingFeedDiscoverySnapshot {
  hostUserId: string
  hasAvailableSlot: boolean
  startingPriceCents: number | null
  windowStartUtc: string
  windowEndUtc: string
  validUntil: string
  computedAt: string
}

function addMilliseconds(isoUtc: string, milliseconds: number): string {
  return new Date(Date.parse(isoUtc) + milliseconds).toISOString()
}

function uniqueHostUserIds(hostUserIds: string[]): string[] {
  return [...new Set(hostUserIds.filter((hostUserId) => hostUserId.trim().length > 0))]
}

export async function invalidateBookingFeedDiscoverySnapshot(
  executor: Client,
  hostUserId: string,
): Promise<void> {
  await executor.execute({
    sql: "DELETE FROM bookings.feed_discovery_snapshots WHERE host_user_id = ?1",
    args: [hostUserId],
  })
}

export async function recomputeBookingFeedDiscoverySnapshot(input: {
  executor: Client
  hostUserId: string
  nowUtc?: string
}): Promise<BookingFeedDiscoverySnapshot | null> {
  const computedAt = input.nowUtc ?? new Date().toISOString()
  const windowStartUtc = computedAt
  const windowEndUtc = addMilliseconds(
    windowStartUtc,
    BOOKING_FEED_DISCOVERY_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  )
  const validUntil = addMilliseconds(computedAt, BOOKING_FEED_DISCOVERY_TTL_MS)
  const availability = await resolveGlobalBookingAvailability({
    executor: input.executor,
    hostUserId: input.hostUserId,
    windowStartUtc,
    windowEndUtc,
    viewerTimezone: "UTC",
    nowUtc: computedAt,
  })
  if (!availability.bookable) {
    await invalidateBookingFeedDiscoverySnapshot(input.executor, input.hostUserId)
    return null
  }

  const prices = availability.slots
    .filter((slot) => slot.available)
    .map((slot) => slot.priceCents)
  const startingPriceCents = prices.length > 0 ? Math.min(...prices) : null
  const snapshot: BookingFeedDiscoverySnapshot = {
    hostUserId: input.hostUserId,
    hasAvailableSlot: startingPriceCents !== null,
    startingPriceCents,
    windowStartUtc,
    windowEndUtc,
    validUntil,
    computedAt,
  }

  await input.executor.execute({
    sql: `
      INSERT INTO bookings.feed_discovery_snapshots (
        host_user_id, has_available_slot, starting_price_cents,
        window_start_utc, window_end_utc, valid_until, computed_at
      ) VALUES (?1, ?2, ?3, ?4::timestamptz, ?5::timestamptz, ?6::timestamptz, ?7::timestamptz)
      ON CONFLICT (host_user_id) DO UPDATE SET
        has_available_slot = EXCLUDED.has_available_slot,
        starting_price_cents = EXCLUDED.starting_price_cents,
        window_start_utc = EXCLUDED.window_start_utc,
        window_end_utc = EXCLUDED.window_end_utc,
        valid_until = EXCLUDED.valid_until,
        computed_at = EXCLUDED.computed_at
    `,
    args: [
      snapshot.hostUserId,
      snapshot.hasAvailableSlot,
      snapshot.startingPriceCents,
      snapshot.windowStartUtc,
      snapshot.windowEndUtc,
      snapshot.validUntil,
      snapshot.computedAt,
    ],
  })
  return snapshot
}

export async function refreshBookingFeedDiscoverySnapshotsInBackground(
  env: Env,
  hostUserIds: string[],
): Promise<void> {
  const uniqueIds = uniqueHostUserIds(hostUserIds)
  if (uniqueIds.length === 0) return

  await withBackgroundControlPlaneClients(async () => {
    const executor = getControlPlaneClient(env)
    const placeholders = uniqueIds.map((_, index) => `?${index + 1}`).join(", ")
    const candidates = await executor.execute({
      sql: `SELECT host_user_id FROM bookings.profiles
            WHERE is_published = TRUE AND host_user_id IN (${placeholders})`,
      args: uniqueIds,
    })
    const publishedIds = candidates.rows
      .map((row) => String(row.host_user_id ?? "").trim())
      .filter(Boolean)
    for (const hostUserId of publishedIds) {
      await recomputeBookingFeedDiscoverySnapshot({ executor, hostUserId })
    }
  })
}
