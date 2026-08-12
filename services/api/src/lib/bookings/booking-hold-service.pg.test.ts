// Real-Postgres tests for global booking hold creation. Runs only when BOOKINGS_REPO_TEST_ADMIN_URL is
// set. Applies canonical core booking migrations and injects the slot resolver so this focused job does not require
// the full api cross-repo install; production still loads @pirate/bookings-domain by default.
import { SQL } from "bun";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { applyCanonicalBookingMigrations } from "./test-migrations";
import type { Client, InStatement, QueryResult, Transaction } from "../sql-client";
import {
  createGlobalBookingHold,
  resolveGlobalBookingAvailability,
  setGlobalBookingResolveSlotsForTests,
} from "./booking-hold-service";

const ADMIN_URL = process.env.BOOKINGS_REPO_TEST_ADMIN_URL;
if (process.env.BOOKINGS_PG_CI_REQUIRED === "true" && !ADMIN_URL) {
  throw new Error("BOOKINGS_REPO_TEST_ADMIN_URL is required for booking hold service PostgreSQL CI");
}
const RUN = Boolean(ADMIN_URL);
const TEST_DB = "bookings_hold_service_test";

function urlFor(db?: string): string {
  const u = new URL(ADMIN_URL as string);
  if (db) u.pathname = `/${db}`;
  if (!u.searchParams.get("sslmode")) u.searchParams.set("sslmode", "disable");
  return u.toString();
}

function connect(db?: string): SQL {
  return new SQL({ url: urlFor(db), tls: false, max: 1, connectionTimeout: 5 } as Record<string, unknown>);
}

function toPg(sql: string): string {
  return sql.replace(/\?(\d+)/gu, (_m, i: string) => `$${i}`);
}

async function execute(conn: { unsafe(sql: string, args?: unknown[]): Promise<unknown> }, statement: InStatement | string): Promise<QueryResult> {
  const st = typeof statement === "string" ? { sql: statement, args: [] as unknown[] } : statement;
  const rows = (await conn.unsafe(toPg(st.sql), st.args ?? [])) as Record<string, unknown>[];
  return { rows };
}

function makeClient(conn: SQL): Client {
  return {
    execute: (statement) => execute(conn, statement),
    async batch(statements) {
      const results: QueryResult[] = [];
      for (const statement of statements) results.push(await execute(conn, statement));
      return results;
    },
    async transaction(): Promise<Transaction> {
      await conn.unsafe("BEGIN");
      return {
        execute: (statement) => execute(conn, statement),
        async batch(statements) {
          const results: QueryResult[] = [];
          for (const statement of statements) results.push(await execute(conn, statement));
          return results;
        },
        async commit() {
          await conn.unsafe("COMMIT");
        },
        async rollback() {
          await conn.unsafe("ROLLBACK");
        },
        close() {},
      };
    },
  };
}

describe.skipIf(!RUN)("global booking hold service (real Postgres)", () => {
  let repoDb: SQL;

  async function seedPublishedHost(hostUserId: string): Promise<void> {
    await repoDb.unsafe(`INSERT INTO bookings.profiles
      (host_user_id, host_timezone, base_price_cents, default_slot_duration_seconds, platform_fee_bps, is_published, created_at, updated_at)
      VALUES ($1, 'UTC', 5000, 1800, 750, true, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')`,
    [hostUserId]);
    await repoDb.unsafe(`INSERT INTO bookings.availability_rules
      (rule_id, host_user_id, by_weekday, start_local, end_local, slot_duration_seconds, created_at, updated_at)
      VALUES ($1, $2, '{3}', '10:00', '12:00', 1800, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')`,
    [`rule_${hostUserId}`, hostUserId]);
  }

  beforeAll(async () => {
    const root = connect();
    await root.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await root.unsafe(`CREATE DATABASE ${TEST_DB}`);
    await root.end();

    const db = connect(TEST_DB);
    for (const r of ["control_plane_api_rw", "control_plane_api_ro"]) {
      await db.unsafe(`DROP ROLE IF EXISTS ${r}`);
      await db.unsafe(`CREATE ROLE ${r} NOLOGIN`);
    }
    await db.unsafe("CREATE EXTENSION IF NOT EXISTS btree_gist");
    await applyCanonicalBookingMigrations(db);
    await db.end();

    repoDb = connect(TEST_DB);
  });

  afterEach(() => {
    setGlobalBookingResolveSlotsForTests(null);
  });

  afterAll(async () => {
    if (repoDb) await repoDb.end();
    const root = connect();
    await root.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {});
    for (const r of ["control_plane_api_rw", "control_plane_api_ro"]) {
      await root.unsafe(`DROP ROLE IF EXISTS ${r}`).catch(() => {});
    }
    await root.end();
    const sentinelPath = process.env.BOOKINGS_PG_SENTINEL_PATH;
    if (sentinelPath) {
      await writeFile(sentinelPath, "booking-hold-service-postgres-suite-complete\n", "utf8");
    }
  });

  test("creates a global hold and slot lock from published host config", async () => {
    await seedPublishedHost("host_hold_service_create");
    setGlobalBookingResolveSlotsForTests((input) => {
      expect(input.rules[0].hostTimezone).toBe("UTC");
      expect(input.rules[0].byWeekday).toEqual([3]);
      expect(input.existingBusyUtc).toEqual([]);
      expect(input.policy.platformFeeBps).toBe(750);
      return [{
        startUtc: "2026-07-01T10:00:00Z",
        endUtc: "2026-07-01T10:30:00Z",
        priceCents: 6250,
        available: true,
      }];
    });

    const result = await createGlobalBookingHold({
      client: makeClient(repoDb),
      sourceCommunityId: "community_discovery_a",
      hostUserId: "host_hold_service_create",
      bookerUserId: "booker_hold_service_create",
      slotStartUtc: "2026-07-01T10:00:00.000Z",
      slotEndUtc: "2026-07-01T10:30:00.000Z",
      nowUtc: "2026-06-10T09:00:00Z",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected hold");
    expect(result.hold.community_id).toBe("community_discovery_a");
    expect(result.hold.source_community_id).toBe("community_discovery_a");
    expect(result.hold.price_cents).toBe(6250);
    expect(result.hold.expires_at_utc).toBe("2026-06-10T09:10:00.000Z");

    const rows = await repoDb.unsafe(`SELECT h.hold_id, h.price_cents, h.source_community_id, l.status AS lock_status
      FROM bookings.holds h
      JOIN bookings.host_slot_locks l ON l.hold_id = h.hold_id
      WHERE h.hold_id = $1`, [result.hold.hold_id]) as Record<string, unknown>[];
    expect(rows).toEqual([{
      hold_id: result.hold.hold_id,
      price_cents: 6250,
      source_community_id: "community_discovery_a",
      lock_status: "active",
    }]);
  });

  test("resolves global availability slots from published host config without writing holds", async () => {
    await seedPublishedHost("host_hold_service_slots");
    setGlobalBookingResolveSlotsForTests((input) => {
      expect(input.windowStartUtc).toBe("2026-07-01T10:00:00Z");
      expect(input.windowEndUtc).toBe("2026-07-01T11:00:00Z");
      expect(input.viewerTimezone).toBe("America/New_York");
      expect(input.basePriceCents).toBe(5000);
      return [{
        startUtc: "2026-07-01T10:00:00Z",
        endUtc: "2026-07-01T10:30:00Z",
        priceCents: 5000,
        available: true,
      }];
    });

    const result = await resolveGlobalBookingAvailability({
      executor: makeClient(repoDb),
      hostUserId: "host_hold_service_slots",
      windowStartUtc: "2026-07-01T10:00:00Z",
      windowEndUtc: "2026-07-01T11:00:00Z",
      viewerTimezone: "America/New_York",
      nowUtc: "2026-06-10T09:00:00Z",
    });

    expect(result.bookable).toBe(true);
    if (!result.bookable) throw new Error("expected bookable host");
    expect(result.hostTimezone).toBe("UTC");
    expect(result.viewerTimezone).toBe("America/New_York");
    expect(result.slots).toEqual([{
      startUtc: "2026-07-01T10:00:00Z",
      endUtc: "2026-07-01T10:30:00Z",
      priceCents: 5000,
      available: true,
    }]);
    const rows = await repoDb.unsafe(`SELECT count(*)::int AS n FROM bookings.holds WHERE host_user_id = $1`,
      ["host_hold_service_slots"]) as Record<string, unknown>[];
    expect(rows[0].n).toBe(0);
  });

  test("rejects unavailable slots before writing hold state", async () => {
    await seedPublishedHost("host_hold_service_unavailable");
    setGlobalBookingResolveSlotsForTests(() => [{
      startUtc: "2026-07-01T10:00:00Z",
      endUtc: "2026-07-01T10:30:00Z",
      priceCents: 5000,
      available: false,
    }]);

    const result = await createGlobalBookingHold({
      client: makeClient(repoDb),
      sourceCommunityId: null,
      hostUserId: "host_hold_service_unavailable",
      bookerUserId: "booker_hold_service_unavailable",
      slotStartUtc: "2026-07-01T10:00:00Z",
      slotEndUtc: "2026-07-01T10:30:00Z",
      nowUtc: "2026-06-10T09:00:00Z",
    });

    expect(result).toEqual({ ok: false, reason: "slot_unavailable" });
    const rows = await repoDb.unsafe(`SELECT count(*)::int AS n FROM bookings.holds WHERE host_user_id = $1`,
      ["host_hold_service_unavailable"]) as Record<string, unknown>[];
    expect(rows[0].n).toBe(0);
  });

  test("maps Postgres overlap conflicts to slot_locked and rolls back the hold insert", async () => {
    await seedPublishedHost("host_hold_service_overlap");
    await repoDb.unsafe(`INSERT INTO bookings.host_slot_locks
      (lock_id, host_user_id, slot_start_utc, slot_end_utc, hold_id, status, expires_at_utc, created_at, updated_at)
      VALUES ('lock_hold_service_overlap_existing', 'host_hold_service_overlap',
        '2026-07-01T10:00:00Z', '2026-07-01T10:30:00Z', 'hold_overlap_existing',
        'active', '2026-06-10T09:10:00Z', '2026-06-10T09:00:00Z', '2026-06-10T09:00:00Z')`);
    setGlobalBookingResolveSlotsForTests(() => [{
      startUtc: "2026-07-01T10:00:00Z",
      endUtc: "2026-07-01T10:30:00Z",
      priceCents: 5000,
      available: true,
    }]);

    const result = await createGlobalBookingHold({
      client: makeClient(repoDb),
      sourceCommunityId: "community_overlap",
      hostUserId: "host_hold_service_overlap",
      bookerUserId: "booker_hold_service_overlap",
      slotStartUtc: "2026-07-01T10:00:00Z",
      slotEndUtc: "2026-07-01T10:30:00Z",
      nowUtc: "2026-06-10T09:00:00Z",
    });

    expect(result).toEqual({ ok: false, reason: "slot_locked" });
    const rows = await repoDb.unsafe(`SELECT count(*)::int AS n FROM bookings.holds WHERE host_user_id = $1`,
      ["host_hold_service_overlap"]) as Record<string, unknown>[];
    expect(rows[0].n).toBe(0);
  });

  test("passes global busy intervals to the resolver and releases expired locks during creation", async () => {
    await seedPublishedHost("host_hold_service_busy");
    await repoDb.unsafe(`INSERT INTO bookings.holds
      (hold_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc, price_cents, status, expires_at_utc, created_at, updated_at)
      VALUES ('hold_busy_existing', 'host_hold_service_busy', 'booker_existing',
        '2026-07-01T11:00:00Z', '2026-07-01T11:30:00Z', 5000, 'active',
        '2026-06-10T09:20:00Z', '2026-06-10T09:00:00Z', '2026-06-10T09:00:00Z')`);
    await repoDb.unsafe(`INSERT INTO bookings.host_slot_locks
      (lock_id, host_user_id, slot_start_utc, slot_end_utc, hold_id, status, expires_at_utc, created_at, updated_at)
      VALUES ('lock_busy_expired', 'host_hold_service_busy',
        '2026-07-01T10:00:00Z', '2026-07-01T10:30:00Z', 'hold_busy_expired',
        'active', '2026-06-10T08:59:00Z', '2026-06-10T08:50:00Z', '2026-06-10T08:50:00Z')`);
    setGlobalBookingResolveSlotsForTests((input) => {
      expect(input.existingBusyUtc).toEqual([{
        startUtc: "2026-07-01T11:00:00.000Z",
        endUtc: "2026-07-01T11:30:00.000Z",
      }]);
      return [{
        startUtc: "2026-07-01T10:00:00Z",
        endUtc: "2026-07-01T10:30:00Z",
        priceCents: 5000,
        available: true,
      }];
    });

    const result = await createGlobalBookingHold({
      client: makeClient(repoDb),
      sourceCommunityId: "community_busy",
      hostUserId: "host_hold_service_busy",
      bookerUserId: "booker_hold_service_busy",
      slotStartUtc: "2026-07-01T10:00:00Z",
      slotEndUtc: "2026-07-01T10:30:00Z",
      nowUtc: "2026-06-10T09:00:00Z",
    });

    expect(result.ok).toBe(true);
    const oldLock = await repoDb.unsafe(`SELECT status FROM bookings.host_slot_locks WHERE lock_id = 'lock_busy_expired'`) as Record<string, unknown>[];
    expect(oldLock[0].status).toBe("released");
  });
});
