import { afterEach, describe, expect, test } from "bun:test"

import type { Client, InStatement, QueryResult } from "../sql-client"
import { setGlobalBookingResolveSlotsForTests } from "./booking-hold-service"
import {
  BOOKING_FEED_DISCOVERY_TTL_MS,
  recomputeBookingFeedDiscoverySnapshot,
} from "./booking-feed-discovery"

const NOW = "2026-07-20T00:00:00.000Z"

function executorWithSnapshotCapture(captured: InStatement[]): Client {
  return {
    async execute(statement: InStatement | string): Promise<QueryResult> {
      const input = typeof statement === "string" ? { sql: statement, args: [] } : statement
      if (input.sql.includes("to_jsonb(p) AS profile")) {
        return {
          rows: [{
            profile: {
              host_user_id: "host_1",
              display_headline: null,
              bio: null,
              topics: null,
              intro_video_ref: null,
              host_timezone: "UTC",
              base_price_cents: 5000,
              default_slot_duration_seconds: 1800,
              platform_fee_bps: 1000,
              payout_wallet_address: "0x0000000000000000000000000000000000000001",
              is_published: true,
              created_at: NOW,
              updated_at: NOW,
            },
            rules: [],
            exceptions: [],
            prices: [],
          }],
        }
      }
      if (input.sql.includes("FROM bookings.holds")) return { rows: [] }
      captured.push(input)
      return { rows: [] }
    },
  } as Client
}

afterEach(() => {
  setGlobalBookingResolveSlotsForTests(null)
})

describe("booking feed discovery snapshots", () => {
  test("stores the minimum price from canonical available slots over the 14-day window", async () => {
    const statements: InStatement[] = []
    setGlobalBookingResolveSlotsForTests(() => [
      { startUtc: "2026-07-20T09:00:00.000Z", endUtc: "2026-07-20T09:30:00.000Z", priceCents: 5000, available: true },
      { startUtc: "2026-07-20T09:30:00.000Z", endUtc: "2026-07-20T10:00:00.000Z", priceCents: 3500, available: true },
      { startUtc: "2026-07-20T10:00:00.000Z", endUtc: "2026-07-20T10:30:00.000Z", priceCents: 1000, available: false },
    ])

    const snapshot = await recomputeBookingFeedDiscoverySnapshot({
      executor: executorWithSnapshotCapture(statements),
      hostUserId: "host_1",
      nowUtc: NOW,
    })

    expect(snapshot).toEqual({
      hostUserId: "host_1",
      hasAvailableSlot: true,
      startingPriceCents: 3500,
      windowStartUtc: NOW,
      windowEndUtc: "2026-08-03T00:00:00.000Z",
      validUntil: new Date(Date.parse(NOW) + BOOKING_FEED_DISCOVERY_TTL_MS).toISOString(),
      computedAt: NOW,
    })
    expect(statements).toHaveLength(1)
    expect(statements[0]?.sql).toContain("INSERT INTO bookings.feed_discovery_snapshots")
    expect(statements[0]?.args).toEqual([
      "host_1",
      true,
      3500,
      NOW,
      "2026-08-03T00:00:00.000Z",
      "2026-07-20T00:10:00.000Z",
      NOW,
    ])
  })

  test("stores an explicit empty-window snapshot with no price", async () => {
    const statements: InStatement[] = []
    setGlobalBookingResolveSlotsForTests(() => [])

    const snapshot = await recomputeBookingFeedDiscoverySnapshot({
      executor: executorWithSnapshotCapture(statements),
      hostUserId: "host_1",
      nowUtc: NOW,
    })

    expect(snapshot?.hasAvailableSlot).toBe(false)
    expect(snapshot?.startingPriceCents).toBeNull()
    expect(statements[0]?.args?.slice(0, 3)).toEqual(["host_1", false, null])
  })
})
