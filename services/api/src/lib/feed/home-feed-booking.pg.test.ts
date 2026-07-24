import { SQL } from "bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { writeFile } from "node:fs/promises"

import { recomputeBookingFeedDiscoverySnapshot } from "../bookings/booking-feed-discovery"
import { applyCanonicalBookingMigrations } from "../bookings/test-migrations"
import {
  listFeedBookingsByHostUserIds,
  type FeedBookingExecutor,
} from "./home-feed-booking"

const ADMIN_URL = process.env.BOOKINGS_REPO_TEST_ADMIN_URL
if (process.env.BOOKINGS_PG_CI_REQUIRED === "true" && !ADMIN_URL) {
  throw new Error("BOOKINGS_REPO_TEST_ADMIN_URL is required for home feed booking discovery PostgreSQL CI")
}
const RUN = Boolean(ADMIN_URL)
const TEST_DB = "feed_booking_discovery_test"
const MONDAY_WINDOW_START = "2026-07-20T00:00:00.000Z"

function urlFor(database?: string): string {
  const url = new URL(ADMIN_URL as string)
  if (database) url.pathname = `/${database}`
  if (!url.searchParams.get("sslmode")) url.searchParams.set("sslmode", "disable")
  return url.toString()
}

function connect(database?: string): SQL {
  return new SQL({
    url: urlFor(database),
    tls: false,
    max: 1,
    connectionTimeout: 5,
  } as Record<string, unknown>)
}

function makeExecutor(connection: {
  unsafe(sql: string, args?: unknown[]): Promise<unknown>
}): FeedBookingExecutor {
  return {
    async execute(statement) {
      const input = typeof statement === "string"
        ? { sql: statement, args: [] as unknown[] }
        : statement
      const sql = input.sql.replace(/\?(\d+)/gu, (_match, index: string) => `$${index}`)
      const rows = await connection.unsafe(sql, input.args ?? []) as Record<string, unknown>[]
      return { rows }
    },
  }
}

describe.skipIf(!RUN)("home feed booking discovery (real Postgres)", () => {
  let database: SQL
  let executor: FeedBookingExecutor

  beforeAll(async () => {
    const root = connect()
    await root.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`)
    await root.unsafe(`CREATE DATABASE ${TEST_DB}`)
    await root.end()

    const setup = connect(TEST_DB)
    for (const role of ["control_plane_api_rw", "control_plane_api_ro"]) {
      await setup.unsafe(`DROP ROLE IF EXISTS ${role}`)
      await setup.unsafe(`CREATE ROLE ${role} NOLOGIN`)
    }
    await setup.unsafe("CREATE EXTENSION IF NOT EXISTS btree_gist")
    await applyCanonicalBookingMigrations(setup)
    await setup.unsafe(`
      INSERT INTO bookings.profiles (
        host_user_id, host_timezone, base_price_cents, default_slot_duration_seconds,
        platform_fee_bps, is_published, created_at, updated_at
      ) VALUES
        ('host_ready', 'UTC', 3500, 1800, 1000, TRUE, NOW(), NOW()),
        ('host_unreachable', 'UTC', 3500, 1800, 1000, TRUE, NOW(), NOW()),
        ('host_priority', 'UTC', 3500, 1800, 1000, TRUE, NOW(), NOW()),
        ('host_blocked', 'UTC', 3500, 3600, 1000, TRUE, NOW(), NOW()),
        ('host_full', 'UTC', 3500, 3600, 1000, TRUE, NOW(), NOW()),
        ('host_no_window', 'UTC', 3500, 1800, 1000, TRUE, NOW(), NOW()),
        ('host_base', 'UTC', 3500, 1800, 1000, TRUE, NOW(), NOW()),
        ('host_above', 'UTC', 3500, 3600, 1000, TRUE, NOW(), NOW()),
        ('host_duration', 'UTC', 3500, 1800, 1000, TRUE, NOW(), NOW()),
        ('host_dst', 'Europe/Berlin', 3500, 1800, 1000, TRUE, NOW(), NOW()),
        ('host_expired', 'UTC', 3500, 1800, 1000, TRUE, NOW(), NOW()),
        ('host_unpublished', 'UTC', 4500, 1800, 1000, FALSE, NOW(), NOW())
    `)
    await setup.unsafe(`
      INSERT INTO bookings.availability_rules (
        rule_id, host_user_id, by_weekday, start_local, end_local,
        slot_duration_seconds, effective_from_utc, created_at, updated_at
      ) VALUES
        ('rule_unreachable', 'host_unreachable', '{1}', '09:00', '10:00', 1800, NULL, NOW(), NOW()),
        ('rule_priority', 'host_priority', '{1}', '09:00', '10:00', 1800, NULL, NOW(), NOW()),
        ('rule_blocked', 'host_blocked', '{1}', '09:00', '11:00', 3600, NULL, NOW(), NOW()),
        ('rule_full', 'host_full', '{1}', '09:00', '10:00', 3600, NULL, NOW(), NOW()),
        ('rule_no_window', 'host_no_window', '{1}', '09:00', '10:00', 1800, '2026-08-04T00:00:00Z', NOW(), NOW()),
        ('rule_base', 'host_base', '{1}', '09:00', '10:00', 1800, NULL, NOW(), NOW()),
        ('rule_above', 'host_above', '{1}', '09:00', '11:00', 3600, NULL, NOW(), NOW()),
        ('rule_duration', 'host_duration', '{1}', '09:00', '10:00', 1800, NULL, NOW(), NOW()),
        ('rule_dst', 'host_dst', '{0}', '01:00', '03:00', 1800, NULL, NOW(), NOW())
    `)
    await setup.unsafe(`
      INSERT INTO bookings.price_rules (
        price_rule_id, host_user_id, match_weekday, match_local_start, match_local_end,
        match_duration_seconds, price_cents, priority, created_at, updated_at
      ) VALUES
        ('price_unreachable', 'host_unreachable', '{0}', NULL, NULL, NULL, 1000, 10, NOW(), NOW()),
        ('price_priority_high', 'host_priority', '{1}', NULL, NULL, 1800, 3000, 20, NOW(), NOW()),
        ('price_priority_low', 'host_priority', '{1}', NULL, NULL, 1800, 1000, 10, NOW(), NOW()),
        ('price_blocked', 'host_blocked', '{1}', '09:00', '10:00', 3600, 2000, 10, NOW(), NOW()),
        ('price_above', 'host_above', '{1}', '09:00', '10:00', 3600, 6000, 10, NOW(), NOW()),
        ('price_duration', 'host_duration', '{1}', NULL, NULL, 3600, 1000, 10, NOW(), NOW()),
        ('price_dst', 'host_dst', '{0}', NULL, NULL, 1800, 2500, 10, NOW(), NOW())
    `)
    await setup.unsafe(`
      INSERT INTO bookings.availability_exceptions (
        exception_id, host_user_id, kind, start_utc, end_utc, created_at
      ) VALUES
        ('block_1', 'host_blocked', 'block', '2026-07-20T09:00:00Z', '2026-07-20T10:00:00Z', NOW()),
        ('block_2', 'host_blocked', 'block', '2026-07-27T09:00:00Z', '2026-07-27T10:00:00Z', NOW())
    `)
    await setup.unsafe(`
      INSERT INTO bookings.holds (
        hold_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc,
        price_cents, status, source_community_id, expires_at_utc, created_at, updated_at
      ) VALUES
        ('hold_1', 'host_full', 'booker_1', '2026-07-20T09:00:00Z', '2026-07-20T10:00:00Z', 3500, 'active', NULL, '2026-08-04T00:00:00Z', NOW(), NOW()),
        ('hold_2', 'host_full', 'booker_2', '2026-07-27T09:00:00Z', '2026-07-27T10:00:00Z', 3500, 'active', NULL, '2026-08-04T00:00:00Z', NOW(), NOW())
    `)
    await setup.unsafe(`
      INSERT INTO bookings.feed_discovery_snapshots (
        host_user_id, has_available_slot, starting_price_cents,
        window_start_utc, window_end_utc, valid_until, computed_at
      ) VALUES
        ('host_ready', TRUE, 2500, NOW(), NOW() + INTERVAL '14 days', NOW() + INTERVAL '10 minutes', NOW()),
        ('host_expired', TRUE, 1500, NOW() - INTERVAL '20 minutes', NOW() + INTERVAL '13 days', NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '20 minutes'),
        ('host_unpublished', TRUE, 1000, NOW(), NOW() + INTERVAL '14 days', NOW() + INTERVAL '10 minutes', NOW())
    `)
    await setup.end()
    database = connect(TEST_DB)
    executor = makeExecutor(database)
  })

  afterAll(async () => {
    if (database) await database.end()
    const root = connect()
    await root.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {})
    for (const role of ["control_plane_api_rw", "control_plane_api_ro"]) {
      await root.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => {})
    }
    await root.end()
    const sentinelPath = process.env.BOOKINGS_PG_SENTINEL_PATH
    if (sentinelPath) {
      await writeFile(sentinelPath, "home-feed-booking-postgres-suite-complete\n", "utf8")
    }
  })

  test("reads only current snapshots for published hosts", async () => {
    const result = await listFeedBookingsByHostUserIds(executor, [
      "host_ready",
      "host_expired",
      "host_unpublished",
      "host_missing",
    ])

    expect([...result.entries()]).toEqual([[
      "host_ready",
      {
        host_user_id: "host_ready",
        base_price_cents: 3500,
        has_available_slot: true,
        starting_price_cents: 2500,
        currency: "USDC",
      },
    ]])
  })

  test("derives floors from canonical available slots rather than raw rule minima", async () => {
    const expected = new Map<string, number | null>([
      ["host_unreachable", 3500],
      ["host_priority", 3000],
      ["host_blocked", 3500],
      ["host_full", null],
      ["host_no_window", null],
      ["host_base", 3500],
      ["host_above", 3500],
      ["host_duration", 3500],
    ])

    for (const [hostUserId, startingPriceCents] of expected) {
      const snapshot = await recomputeBookingFeedDiscoverySnapshot({
        executor: executor as never,
        hostUserId,
        nowUtc: MONDAY_WINDOW_START,
      })
      expect(snapshot?.startingPriceCents, hostUserId).toBe(startingPriceCents)
      expect(snapshot?.hasAvailableSlot, hostUserId).toBe(startingPriceCents !== null)
    }
  })

  test("resolves a DST-boundary window in the host timezone", async () => {
    const snapshot = await recomputeBookingFeedDiscoverySnapshot({
      executor: executor as never,
      hostUserId: "host_dst",
      nowUtc: "2026-10-24T00:00:00.000Z",
    })

    expect(snapshot?.hasAvailableSlot).toBe(true)
    expect(snapshot?.startingPriceCents).toBe(2500)
  })
})
