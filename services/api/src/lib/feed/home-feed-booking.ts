import type { HomeFeedItem } from "../../types"
import { requiredNumber, requiredString } from "../sql-row"
import type { InStatement, QueryResult } from "../sql-client"

type FeedBooking = NonNullable<HomeFeedItem["booking"]>

export interface FeedBookingExecutor {
  execute(statement: InStatement | string): Promise<QueryResult>
}

export type FeedBookingLookup = (
  hostUserIds: string[],
) => Promise<Map<string, FeedBooking>>

const DEFAULT_LOOKUP_TIMEOUT_MS = 250
const LOOKUP_UNAVAILABLE: unique symbol = Symbol("feed-booking-lookup-unavailable")

function uniqueHostUserIds(hostUserIds: string[]): string[] {
  return [...new Set(hostUserIds.filter((hostUserId) => hostUserId.trim().length > 0))]
}

/**
 * Batch-resolves booking discovery metadata. Presence means the host is configured enough to
 * accept bookings: the profile is published and at least one availability rule exists.
 */
export async function listFeedBookingsByHostUserIds(
  executor: FeedBookingExecutor,
  hostUserIds: string[],
): Promise<Map<string, FeedBooking>> {
  const uniqueIds = uniqueHostUserIds(hostUserIds)
  if (uniqueIds.length === 0) return new Map()

  const placeholders = uniqueIds.map((_, index) => `?${index + 1}`).join(", ")
  const result = await executor.execute({
    sql: `
      SELECT p.host_user_id, p.base_price_cents
      FROM bookings.profiles p
      WHERE p.host_user_id IN (${placeholders})
        AND p.is_published = TRUE
        AND EXISTS (
          SELECT 1
          FROM bookings.availability_rules r
          WHERE r.host_user_id = p.host_user_id
        )
      ORDER BY p.host_user_id ASC
    `,
    args: uniqueIds,
  })

  return new Map(result.rows.map((row) => {
    const hostUserId = requiredString(row, "host_user_id")
    const basePriceCents = requiredNumber(row, "base_price_cents")
    if (!Number.isSafeInteger(basePriceCents) || basePriceCents < 0) {
      throw new TypeError("Feed booking base price must be a non-negative integer")
    }
    return [hostUserId, {
      host_user_id: hostUserId,
      base_price_cents: basePriceCents,
      currency: "USDC" as const,
    }]
  }))
}

function discoverableAuthorUserId(item: HomeFeedItem): string | null {
  const post = item.post.post
  if (post.identity_mode !== "public" || post.authorship_mode !== "human_direct") return null
  return post.author_user?.trim() || null
}

/**
 * Adds optional booking blocks without changing feed availability. Booking discovery becomes
 * unavailable on errors or slowness so it cannot take down the home/video feed.
 */
export async function decorateHomeFeedItemsWithBookings(input: {
  items: HomeFeedItem[]
  lookup: FeedBookingLookup
  lookupTimeoutMs?: number
}): Promise<HomeFeedItem[]> {
  const hostUserIds = uniqueHostUserIds(
    input.items.flatMap((item) => {
      const hostUserId = discoverableAuthorUserId(item)
      return hostUserId ? [hostUserId] : []
    }),
  )
  if (hostUserIds.length === 0) return input.items

  const lookup = input
    .lookup(hostUserIds)
    .catch((): typeof LOOKUP_UNAVAILABLE => LOOKUP_UNAVAILABLE)
  const timeoutMs = Math.max(
    0,
    input.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS,
  )
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<typeof LOOKUP_UNAVAILABLE>((resolve) => {
    timeoutId = setTimeout(() => resolve(LOOKUP_UNAVAILABLE), timeoutMs)
  })
  const bookingByHostUserId = await Promise.race([lookup, timeout])
  if (timeoutId !== undefined) clearTimeout(timeoutId)

  if (bookingByHostUserId === LOOKUP_UNAVAILABLE) {
    return input.items
  }

  return input.items.map((item) => {
    const hostUserId = discoverableAuthorUserId(item)
    const booking = hostUserId ? bookingByHostUserId.get(hostUserId) : undefined
    return booking ? { ...item, booking } : item
  })
}
