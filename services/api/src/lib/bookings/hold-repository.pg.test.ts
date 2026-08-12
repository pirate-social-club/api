// Real-Postgres tests for global bookings holds + host slot locks. Runs only when
// BOOKINGS_REPO_TEST_ADMIN_URL is set. Applies canonical core booking migrations and exercises the repository through
// the same lightweight executor shape used by the host-config repository tests.
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { applyCanonicalBookingMigrations } from "./test-migrations";
import {
  createBookingHoldRepository, createBookingHoldTxWriteRepository, createBookingHoldWriteRepository,
  type BookingHoldSqlExecutor,
} from "./hold-repository";

const ADMIN_URL = process.env.BOOKINGS_REPO_TEST_ADMIN_URL;
if (process.env.BOOKINGS_PG_CI_REQUIRED === "true" && !ADMIN_URL) {
  throw new Error("BOOKINGS_REPO_TEST_ADMIN_URL is required for bookings hold repository PostgreSQL CI");
}
const RUN = Boolean(ADMIN_URL);
const TEST_DB = "bookings_hold_repo_test";

function urlFor(db?: string): string {
  const u = new URL(ADMIN_URL as string);
  if (db) u.pathname = `/${db}`;
  if (!u.searchParams.get("sslmode")) u.searchParams.set("sslmode", "disable");
  return u.toString();
}

function connect(db?: string): SQL {
  return new SQL({ url: urlFor(db), tls: false, max: 1, connectionTimeout: 5 } as Record<string, unknown>);
}

function makeExecutor(conn: { unsafe(sql: string, args?: unknown[]): Promise<unknown> }): BookingHoldSqlExecutor {
  const toPg = (s: string) => s.replace(/\?(\d+)/gu, (_m, i: string) => `$${i}`);
  return {
    async execute(statement) {
      const st = typeof statement === "string" ? { sql: statement, args: [] as unknown[] } : statement;
      const rows = (await conn.unsafe(toPg(st.sql), st.args ?? [])) as Record<string, unknown>[];
      return { rows };
    },
  };
}

describe.skipIf(!RUN)("bookings hold repository (real Postgres)", () => {
  let repoDb: SQL;

  async function seedProfile(hostUserId: string): Promise<void> {
    await repoDb.unsafe(`INSERT INTO bookings.profiles
      (host_user_id, host_timezone, base_price_cents, default_slot_duration_seconds, created_at, updated_at)
      VALUES ($1, 'UTC', 5000, 1800, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')
      ON CONFLICT (host_user_id) DO NOTHING`, [hostUserId]);
  }

  function writeRepo() {
    return createBookingHoldWriteRepository(makeExecutor(repoDb));
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
    await db.unsafe(`CREATE EXTENSION IF NOT EXISTS btree_gist`);
    await applyCanonicalBookingMigrations(db);
    await db.end();

    repoDb = connect(TEST_DB);
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
      await writeFile(sentinelPath, "hold-repository-postgres-suite-complete\n", "utf8");
    }
  });

  test("transaction-bound createHoldWithSlotLock creates an active hold and active lock", async () => {
    const hostUserId = "hold_host_create";
    await seedProfile(hostUserId);

    await repoDb.begin(async (tx: { unsafe(sql: string, args?: unknown[]): Promise<unknown> }) => {
      const repo = createBookingHoldTxWriteRepository(makeExecutor(tx));
      const result = await repo.createHoldWithSlotLock({
        nowUtc: "2026-06-10T10:00:00Z",
        lock: {
          lockId: "lock_create_1",
          holdId: "hold_create_1",
          hostUserId,
          slotStartUtc: "2026-07-01T10:00:00Z",
          slotEndUtc: "2026-07-01T11:00:00Z",
          sourceCommunityId: "community_a",
          expiresAtUtc: "2026-06-10T10:10:00Z",
          createdAt: "2026-06-10T10:00:00Z",
        },
        hold: {
          holdId: "hold_create_1",
          hostUserId,
          bookerUserId: "booker_1",
          slotStartUtc: "2026-07-01T10:00:00Z",
          slotEndUtc: "2026-07-01T11:00:00Z",
          priceCents: 5000,
          sourceCommunityId: "community_a",
          expiresAtUtc: "2026-06-10T10:10:00Z",
          createdAt: "2026-06-10T10:00:00Z",
        },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.hold.status).toBe("active");
        expect(result.lock.status).toBe("active");
        expect(result.lock.sourceCommunityId).toBe("community_a");
      }
    });

    const read = createBookingHoldRepository(makeExecutor(repoDb));
    expect((await read.getHold("hold_create_1"))!.expiresAtUtc).toBe("2026-06-10T10:10:00.000Z");
    expect((await read.getActiveSlotLockByHold("hold_create_1"))!.lockId).toBe("lock_create_1");
  });

  test("overlapping active slot locks map to slot-conflict and do not insert the hold", async () => {
    const hostUserId = "hold_host_overlap";
    await seedProfile(hostUserId);
    const write = writeRepo();

    const first = await write.createSlotLock({
      lockId: "lock_overlap_1",
      hostUserId,
      holdId: "hold_overlap_1",
      slotStartUtc: "2026-07-02T10:00:00Z",
      slotEndUtc: "2026-07-02T11:00:00Z",
      expiresAtUtc: "2026-06-10T10:10:00Z",
      createdAt: "2026-06-10T10:00:00Z",
    });
    expect(first.ok).toBe(true);

    await repoDb.begin(async (tx: { unsafe(sql: string, args?: unknown[]): Promise<unknown> }) => {
      const repo = createBookingHoldTxWriteRepository(makeExecutor(tx));
      const result = await repo.createHoldWithSlotLock({
        nowUtc: "2026-06-10T10:00:00Z",
        lock: {
          lockId: "lock_overlap_2",
          holdId: "hold_overlap_2",
          hostUserId,
          slotStartUtc: "2026-07-02T10:30:00Z",
          slotEndUtc: "2026-07-02T11:30:00Z",
          expiresAtUtc: "2026-06-10T10:10:00Z",
          createdAt: "2026-06-10T10:00:00Z",
        },
        hold: {
          holdId: "hold_overlap_2",
          hostUserId,
          bookerUserId: "booker_2",
          slotStartUtc: "2026-07-02T10:30:00Z",
          slotEndUtc: "2026-07-02T11:30:00Z",
          priceCents: 6000,
          expiresAtUtc: "2026-06-10T10:10:00Z",
          createdAt: "2026-06-10T10:00:00Z",
        },
      });
      expect(result).toEqual({ ok: false, reason: "slot-conflict" });
    });

    const read = createBookingHoldRepository(makeExecutor(repoDb));
    expect(await read.getHold("hold_overlap_2")).toBeNull();
    expect(await read.getSlotLock("lock_overlap_2")).toBeNull();
  });

  test("released or expired slot locks no longer block an overlapping active lock", async () => {
    const hostUserId = "hold_host_reuse";
    await seedProfile(hostUserId);
    const write = writeRepo();

    expect((await write.createSlotLock({
      lockId: "lock_reuse_1",
      hostUserId,
      holdId: "hold_reuse_1",
      slotStartUtc: "2026-07-03T10:00:00Z",
      slotEndUtc: "2026-07-03T11:00:00Z",
      expiresAtUtc: "2026-06-10T10:10:00Z",
      createdAt: "2026-06-10T10:00:00Z",
    })).ok).toBe(true);
    expect((await write.releaseSlotLock("lock_reuse_1", "2026-06-10T10:01:00Z"))!.status).toBe("released");
    expect((await write.createSlotLock({
      lockId: "lock_reuse_2",
      hostUserId,
      holdId: "hold_reuse_2",
      slotStartUtc: "2026-07-03T10:30:00Z",
      slotEndUtc: "2026-07-03T11:30:00Z",
      expiresAtUtc: "2026-06-10T10:10:00Z",
      createdAt: "2026-06-10T10:02:00Z",
    })).ok).toBe(true);

    expect((await write.createSlotLock({
      lockId: "lock_reuse_expired",
      hostUserId,
      holdId: "hold_reuse_expired",
      slotStartUtc: "2026-07-04T10:00:00Z",
      slotEndUtc: "2026-07-04T11:00:00Z",
      expiresAtUtc: "2026-06-10T10:00:00Z",
      createdAt: "2026-06-10T09:50:00Z",
    })).ok).toBe(true);
    const released = await write.releaseExpiredSlotLocks(hostUserId, "2026-06-10T10:00:00Z");
    expect(released.map((lock) => lock.lockId)).toContain("lock_reuse_expired");
    expect((await write.createSlotLock({
      lockId: "lock_reuse_after_expiry",
      hostUserId,
      holdId: "hold_reuse_after_expiry",
      slotStartUtc: "2026-07-04T10:30:00Z",
      slotEndUtc: "2026-07-04T11:30:00Z",
      expiresAtUtc: "2026-06-10T10:10:00Z",
      createdAt: "2026-06-10T10:01:00Z",
    })).ok).toBe(true);
  });

  test("hold lifecycle helpers consume, expire, and make locks permanent with CAS semantics", async () => {
    const hostUserId = "hold_host_lifecycle";
    await seedProfile(hostUserId);
    const write = writeRepo();

    await write.createHold({
      holdId: "hold_lifecycle_consume",
      hostUserId,
      bookerUserId: "booker_lifecycle",
      slotStartUtc: "2026-07-05T10:00:00Z",
      slotEndUtc: "2026-07-05T11:00:00Z",
      priceCents: 7000,
      expiresAtUtc: "2026-06-10T10:10:00Z",
      createdAt: "2026-06-10T10:00:00Z",
    });
    expect((await write.consumeHold("hold_lifecycle_consume", "2026-06-10T10:02:00Z"))!.status).toBe("consumed");
    expect(await write.expireHold("hold_lifecycle_consume", "2026-06-10T10:03:00Z")).toBeNull();

    await write.createHold({
      holdId: "hold_lifecycle_expire",
      hostUserId,
      bookerUserId: "booker_lifecycle",
      slotStartUtc: "2026-07-05T12:00:00Z",
      slotEndUtc: "2026-07-05T13:00:00Z",
      priceCents: 7000,
      expiresAtUtc: "2026-06-10T10:00:00Z",
      createdAt: "2026-06-10T09:50:00Z",
    });
    expect((await write.expireDueHolds("2026-06-10T10:00:00Z")).map((hold) => hold.holdId)).toContain("hold_lifecycle_expire");

    expect((await write.createSlotLock({
      lockId: "lock_lifecycle_permanent",
      hostUserId,
      holdId: "hold_lifecycle_consume",
      slotStartUtc: "2026-07-05T10:00:00Z",
      slotEndUtc: "2026-07-05T11:00:00Z",
      expiresAtUtc: "2026-06-10T10:10:00Z",
      createdAt: "2026-06-10T10:00:00Z",
    })).ok).toBe(true);
    const permanent = await write.makeSlotLockPermanent("hold_lifecycle_consume", "booking_lifecycle", "2026-06-10T10:04:00Z");
    expect(permanent!.bookingId).toBe("booking_lifecycle");
    expect(permanent!.expiresAtUtc).toBeNull();
  });

  test("transaction-bound create rolls back both hold and slot lock", async () => {
    const hostUserId = "hold_host_rollback";
    await seedProfile(hostUserId);
    await expect(repoDb.begin(async (tx: { unsafe(sql: string, args?: unknown[]): Promise<unknown> }) => {
      const repo = createBookingHoldTxWriteRepository(makeExecutor(tx));
      await repo.createHoldWithSlotLock({
        nowUtc: "2026-06-10T10:00:00Z",
        lock: {
          lockId: "lock_rollback_1",
          holdId: "hold_rollback_1",
          hostUserId,
          slotStartUtc: "2026-07-06T10:00:00Z",
          slotEndUtc: "2026-07-06T11:00:00Z",
          expiresAtUtc: "2026-06-10T10:10:00Z",
          createdAt: "2026-06-10T10:00:00Z",
        },
        hold: {
          holdId: "hold_rollback_1",
          hostUserId,
          bookerUserId: "booker_rollback",
          slotStartUtc: "2026-07-06T10:00:00Z",
          slotEndUtc: "2026-07-06T11:00:00Z",
          priceCents: 8000,
          expiresAtUtc: "2026-06-10T10:10:00Z",
          createdAt: "2026-06-10T10:00:00Z",
        },
      });
      throw new Error("rollback_probe");
    })).rejects.toThrow("rollback_probe");

    const read = createBookingHoldRepository(makeExecutor(repoDb));
    expect(await read.getHold("hold_rollback_1")).toBeNull();
    expect(await read.getSlotLock("lock_rollback_1")).toBeNull();
  });
});
