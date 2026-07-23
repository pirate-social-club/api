import { SQL } from "bun"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

import { applyCanonicalBookingMigrations } from "../bookings/test-migrations"
import {
  listFeedBookingsByHostUserIds,
  type FeedBookingExecutor,
} from "./home-feed-booking"

const ADMIN_URL = process.env.BOOKINGS_REPO_TEST_ADMIN_URL
const RUN = Boolean(ADMIN_URL)
const TEST_DB = "feed_booking_discovery_test"

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
        ('host_no_rules', 'UTC', 4000, 1800, 1000, TRUE, NOW(), NOW()),
        ('host_unpublished', 'UTC', 4500, 1800, 1000, FALSE, NOW(), NOW())
    `)
    await setup.unsafe(`
      INSERT INTO bookings.availability_rules (
        rule_id, host_user_id, by_weekday, start_local, end_local,
        slot_duration_seconds, created_at, updated_at
      ) VALUES
        ('rule_ready', 'host_ready', '{1}', '09:00', '10:00', 1800, NOW(), NOW()),
        ('rule_unpublished', 'host_unpublished', '{2}', '09:00', '10:00', 1800, NOW(), NOW())
    `)
    await setup.unsafe(`
      INSERT INTO bookings.price_rules (
        price_rule_id, host_user_id, match_weekday, match_local_start, match_local_end,
        match_duration_seconds, price_cents, priority, created_at, updated_at
      ) VALUES
        ('price_ready_low', 'host_ready', 1, '09:00', '09:30', 1800, 2500, 20, NOW(), NOW()),
        ('price_ready_high', 'host_ready', 1, '09:30', '10:00', 1800, 5000, 10, NOW(), NOW())
    `)
    await setup.end()
    database = connect(TEST_DB)
  })

  afterAll(async () => {
    if (database) await database.end()
    const root = connect()
    await root.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {})
    for (const role of ["control_plane_api_rw", "control_plane_api_ro"]) {
      await root.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => {})
    }
    await root.end()
  })

  test("returns only published hosts with configured availability", async () => {
    const result = await listFeedBookingsByHostUserIds(makeExecutor(database), [
      "host_ready",
      "host_no_rules",
      "host_unpublished",
      "host_missing",
    ])

    expect([...result.entries()]).toEqual([[
      "host_ready",
      {
        host_user_id: "host_ready",
        base_price_cents: 3500,
        starting_price_cents: 2500,
        currency: "USDC",
      },
    ]])
  })
})
