// Real-Postgres tests for global booking lifecycle + attendance repository. Runs only when
// BOOKINGS_REPO_TEST_ADMIN_URL is set. Applies canonical core b0001 and validates CAS transitions,
// identity-bound attendance writes, and tx-bound rollback against real constraints.
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveCoreRepoPath } from "../../../shared/core-repo-paths";
import {
  createBookingLifecycleRepository,
  createBookingLifecycleTxWriteRepository,
  createBookingLifecycleWriteRepository,
  type BookingLifecycleSqlExecutor,
} from "./booking-lifecycle-repository";

const ADMIN_URL = process.env.BOOKINGS_REPO_TEST_ADMIN_URL;
const RUN = Boolean(ADMIN_URL);
const TEST_DB = "bookings_lifecycle_repo_test";

function urlFor(db?: string): string {
  const u = new URL(ADMIN_URL as string);
  if (db) u.pathname = `/${db}`;
  if (!u.searchParams.get("sslmode")) u.searchParams.set("sslmode", "disable");
  return u.toString();
}

function connect(db?: string): SQL {
  return new SQL({ url: urlFor(db), tls: false, max: 1, connectionTimeout: 5 } as Record<string, unknown>);
}

function makeExecutor(conn: { unsafe(sql: string, args?: unknown[]): Promise<unknown> }): BookingLifecycleSqlExecutor {
  const toPg = (s: string) => s.replace(/\?(\d+)/gu, (_m, i: string) => `$${i}`);
  return {
    async execute(statement) {
      const st = typeof statement === "string" ? { sql: statement, args: [] as unknown[] } : statement;
      const rows = (await conn.unsafe(toPg(st.sql), st.args ?? [])) as Record<string, unknown>[];
      return { rows };
    },
  };
}

describe.skipIf(!RUN)("bookings lifecycle repository (real Postgres)", () => {
  let repoDb: SQL;

  async function seedBooking(input: {
    bookingId: string;
    status?: "confirmed" | "live" | "completed" | "cancelled_by_host" | "cancelled_by_booker";
    hostUserId?: string;
    bookerUserId?: string;
    lock?: boolean;
    liveRoomId?: string | null;
  }): Promise<void> {
    const hostUserId = input.hostUserId ?? `host_${input.bookingId}`;
    const bookerUserId = input.bookerUserId ?? `booker_${input.bookingId}`;
    const status = input.status ?? "confirmed";
    await repoDb.unsafe(`INSERT INTO bookings.profiles
      (host_user_id, host_timezone, base_price_cents, default_slot_duration_seconds, payout_wallet_address, created_at, updated_at)
      VALUES ($1, 'UTC', 5000, 1800, '0xpayout', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')`, [hostUserId]);
    await repoDb.unsafe(`INSERT INTO bookings.bookings (
        booking_id, hold_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc,
        gross_cents, platform_fee_bps, platform_fee_cents, host_payout_cents, refund_cents, status,
        funding_tx_ref, payout_tx_ref, refund_tx_ref, funding_wallet_address, host_payout_wallet_address,
        live_room_id, source_community_id, confirmed_at, completed_at, settled_at, cancelled_at, created_at, updated_at
      ) VALUES (
        $1, NULL, $2, $3, '2026-07-01T10:00:00Z', '2026-07-01T11:00:00Z',
        5000, 500, 250, 4750, NULL, $4,
        $5, NULL, NULL, '0xfunder', '0xpayout',
        $6, 'community_lifecycle', '2026-06-10T10:02:00Z',
        CASE WHEN $4 = 'completed' THEN '2026-07-01T11:00:00Z'::timestamptz ELSE NULL END,
        NULL,
        CASE WHEN $4 IN ('cancelled_by_host', 'cancelled_by_booker') THEN '2026-06-11T10:00:00Z'::timestamptz ELSE NULL END,
        '2026-06-10T10:02:00Z', '2026-06-10T10:02:00Z'
      )`, [input.bookingId, hostUserId, bookerUserId, status, `0xfunding_${input.bookingId}`, input.liveRoomId ?? null]);
    if (input.lock) {
      await repoDb.unsafe(`INSERT INTO bookings.host_slot_locks
        (lock_id, host_user_id, slot_start_utc, slot_end_utc, booking_id, status, source_community_id, expires_at_utc, created_at, updated_at)
        VALUES ($1, $2, '2026-07-01T10:00:00Z', '2026-07-01T11:00:00Z', $3, 'active', 'community_lifecycle', NULL, '2026-06-10T10:02:00Z', '2026-06-10T10:02:00Z')`,
      [`lock_${input.bookingId}`, hostUserId, input.bookingId]);
    }
  }

  function writeRepo() {
    return createBookingLifecycleWriteRepository(makeExecutor(repoDb));
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
    await db.unsafe(readFileSync(resolveCoreRepoPath("db/bookings/migrations/b0001_bookings_global_schema.sql"), "utf8"));
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
  });

  test("starts confirmed bookings with a status CAS", async () => {
    await seedBooking({ bookingId: "bkg_lifecycle_start" });
    const repo = writeRepo();

    const started = await repo.startBookingSession("bkg_lifecycle_start", "2026-07-01T09:56:00Z");
    expect(started?.status).toBe("live");
    expect(started?.updatedAt).toBe("2026-07-01T09:56:00.000Z");
    expect(await repo.startBookingSession("bkg_lifecycle_start", "2026-07-01T09:57:00Z")).toBeNull();
  });

  test("reserves settlement intents and finalizes terminal state with tx refs", async () => {
    await seedBooking({ bookingId: "bkg_lifecycle_settle", status: "live", lock: true });
    const repo = writeRepo();

    const intent = await repo.reserveBookingSettlementIntent({
      bookingId: "bkg_lifecycle_settle",
      fromStatus: "live",
      toStatus: "completed",
      refundCents: 0,
      nowUtc: "2026-07-01T11:01:00Z",
    });
    expect(intent?.status).toBe("completed");
    expect(intent?.refundCents).toBe(0);
    expect(intent?.completedAt).toBe("2026-07-01T11:01:00.000Z");

    const settled = await repo.finalizeBookingSettlement({
      bookingId: "bkg_lifecycle_settle",
      fromStatus: "completed",
      finalStatus: "settled",
      payoutTxRef: "0xpayout_lifecycle",
      nowUtc: "2026-07-01T11:02:00Z",
    });
    expect(settled?.status).toBe("settled");
    expect(settled?.payoutTxRef).toBe("0xpayout_lifecycle");
    expect(settled?.settledAt).toBe("2026-07-01T11:02:00.000Z");

    const released = await repo.releaseBookingSlotLock("bkg_lifecycle_settle", "2026-07-01T11:03:00Z");
    expect(released?.status).toBe("released");
    expect(await repo.releaseBookingSlotLock("bkg_lifecycle_settle", "2026-07-01T11:04:00Z")).toBeNull();
  });

  test("cancellation intent finalizes to refunded without settled_at", async () => {
    await seedBooking({ bookingId: "bkg_lifecycle_refund", status: "confirmed" });
    const repo = writeRepo();

    const intent = await repo.reserveBookingSettlementIntent({
      bookingId: "bkg_lifecycle_refund",
      fromStatus: "confirmed",
      toStatus: "cancelled_by_host",
      refundCents: 5000,
      nowUtc: "2026-06-11T10:00:00Z",
    });
    expect(intent?.status).toBe("cancelled_by_host");
    expect(intent?.cancelledAt).toBe("2026-06-11T10:00:00.000Z");
    expect(await repo.reserveBookingSettlementIntent({
      bookingId: "bkg_lifecycle_refund",
      fromStatus: "confirmed",
      toStatus: "cancelled_by_booker",
      refundCents: 0,
      nowUtc: "2026-06-11T10:01:00Z",
    })).toBeNull();

    const refunded = await repo.finalizeBookingSettlement({
      bookingId: "bkg_lifecycle_refund",
      fromStatus: "cancelled_by_host",
      finalStatus: "refunded",
      refundTxRef: "0xrefund_lifecycle",
      nowUtc: "2026-06-11T10:02:00Z",
    });
    expect(refunded?.status).toBe("refunded");
    expect(refunded?.refundTxRef).toBe("0xrefund_lifecycle");
    expect(refunded?.settledAt).toBeNull();
  });

  test("attaches attendance only for matching parties on attachable bookings", async () => {
    await seedBooking({ bookingId: "bkg_lifecycle_attendance", status: "confirmed" });
    await seedBooking({ bookingId: "bkg_lifecycle_attendance_done", status: "completed" });
    const repo = writeRepo();

    const hostSession = await repo.attachAttendanceSession({
      sessionId: "bas_lifecycle_host",
      bookingId: "bkg_lifecycle_attendance",
      party: "host",
      userId: "host_bkg_lifecycle_attendance",
      agoraUid: 12345,
      attachedAt: "2026-07-01T09:55:00Z",
    });
    expect(hostSession?.party).toBe("host");
    expect(hostSession?.agoraUid).toBe(12345);
    expect(await repo.attachAttendanceSession({
      sessionId: "bas_lifecycle_wrong_party",
      bookingId: "bkg_lifecycle_attendance",
      party: "booker",
      userId: "host_bkg_lifecycle_attendance",
      attachedAt: "2026-07-01T09:56:00Z",
    })).toBeNull();
    expect(await repo.attachAttendanceSession({
      sessionId: "bas_lifecycle_terminal",
      bookingId: "bkg_lifecycle_attendance_done",
      party: "host",
      userId: "host_bkg_lifecycle_attendance_done",
      attachedAt: "2026-07-01T09:56:00Z",
    })).toBeNull();

    const room = await repo.setBookingLiveRoomIfUnset("bkg_lifecycle_attendance", "pirate-booking-bkg_lifecycle_attendance", "2026-07-01T09:55:01Z");
    expect(room?.liveRoomId).toBe("pirate-booking-bkg_lifecycle_attendance");
    expect(await repo.setBookingLiveRoomIfUnset("bkg_lifecycle_attendance", "different", "2026-07-01T09:55:02Z")).toBeNull();
  });

  test("heartbeats are identity-bound and ordered for evaluator reads", async () => {
    await seedBooking({ bookingId: "bkg_lifecycle_heartbeat", status: "live" });
    const repo = writeRepo();
    await repo.attachAttendanceSession({
      sessionId: "bas_lifecycle_heartbeat",
      bookingId: "bkg_lifecycle_heartbeat",
      party: "booker",
      userId: "booker_bkg_lifecycle_heartbeat",
      agoraUid: null,
      attachedAt: "2026-07-01T10:00:00Z",
    });

    expect(await repo.heartbeatAttendanceSession({
      heartbeatId: "bah_lifecycle_wrong",
      sessionId: "bas_lifecycle_heartbeat",
      bookingId: "bkg_lifecycle_heartbeat",
      userId: "host_bkg_lifecycle_heartbeat",
      seenAt: "2026-07-01T10:00:10Z",
    })).toEqual({ ok: false, reason: "not-found" });

    const heartbeat = await repo.heartbeatAttendanceSession({
      heartbeatId: "bah_lifecycle_seen",
      sessionId: "bas_lifecycle_heartbeat",
      bookingId: "bkg_lifecycle_heartbeat",
      userId: "booker_bkg_lifecycle_heartbeat",
      seenAt: "2026-07-01T10:00:20Z",
    });
    expect(heartbeat.ok).toBe(true);
    if (!heartbeat.ok) throw new Error("expected heartbeat");
    expect(heartbeat.session.lastSeenAt).toBe("2026-07-01T10:00:20.000Z");
    expect(heartbeat.heartbeat.seenAt).toBe("2026-07-01T10:00:20.000Z");

    const ended = await repo.endAttendanceSession("bas_lifecycle_heartbeat", "booker_bkg_lifecycle_heartbeat", "2026-07-01T10:30:00Z");
    expect(ended?.endedAt).toBe("2026-07-01T10:30:00.000Z");
    expect(await repo.endAttendanceSession("bas_lifecycle_heartbeat", "someone_else", "2026-07-01T10:31:00Z")).toBeNull();

    expect((await repo.listAttendanceSessions("bkg_lifecycle_heartbeat")).map((s) => s.sessionId)).toEqual(["bas_lifecycle_heartbeat"]);
    expect((await repo.listAttendanceHeartbeats("bas_lifecycle_heartbeat")).map((h) => h.heartbeatId)).toEqual(["bah_lifecycle_seen"]);
  });

  test("transaction-bound lifecycle and attendance writes roll back", async () => {
    await seedBooking({ bookingId: "bkg_lifecycle_rollback", status: "confirmed" });
    await expect(repoDb.begin(async (tx: { unsafe(sql: string, args?: unknown[]): Promise<unknown> }) => {
      const repo = createBookingLifecycleTxWriteRepository(makeExecutor(tx));
      expect((await repo.startBookingSession("bkg_lifecycle_rollback", "2026-07-01T09:56:00Z"))?.status).toBe("live");
      expect(await repo.attachAttendanceSession({
        sessionId: "bas_lifecycle_rollback",
        bookingId: "bkg_lifecycle_rollback",
        party: "host",
        userId: "host_bkg_lifecycle_rollback",
        attachedAt: "2026-07-01T09:56:00Z",
      })).not.toBeNull();
      throw new Error("rollback_probe");
    })).rejects.toThrow("rollback_probe");

    const read = createBookingLifecycleRepository(makeExecutor(repoDb));
    expect((await read.getBooking("bkg_lifecycle_rollback"))?.status).toBe("confirmed");
    expect(await read.getAttendanceSession("bas_lifecycle_rollback")).toBeNull();
  });
});
