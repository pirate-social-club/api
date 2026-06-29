// Real-Postgres tests for global booking lifecycle service behavior that is route-facing and
// non-settlement: start, session attach, and heartbeat. Runs only when BOOKINGS_REPO_TEST_ADMIN_URL is
// set and applies canonical core b0001.
import { SQL } from "bun";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Env } from "../../env";
import { resolveCoreRepoPath } from "../../../shared/core-repo-paths";
import type { BookingLifecycleSqlExecutor } from "./booking-lifecycle-repository";
import {
  attachGlobalBookingSession,
  heartbeatGlobalBookingSession,
  setGlobalBookingAgoraBuilderForTests,
  startGlobalBookingSession,
} from "./booking-lifecycle-service";

const ADMIN_URL = process.env.BOOKINGS_REPO_TEST_ADMIN_URL;
const RUN = Boolean(ADMIN_URL);
const TEST_DB = "bookings_lifecycle_service_test";

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

describe.skipIf(!RUN)("global booking lifecycle service (real Postgres)", () => {
  let repoDb: SQL;

  async function seedBooking(input: {
    bookingId: string;
    status?: "confirmed" | "live" | "completed";
    hostUserId?: string;
    bookerUserId?: string;
    slotStartUtc?: string;
    slotEndUtc?: string;
  }): Promise<void> {
    const hostUserId = input.hostUserId ?? `host_${input.bookingId}`;
    const bookerUserId = input.bookerUserId ?? `booker_${input.bookingId}`;
    await repoDb.unsafe(`INSERT INTO bookings.profiles
      (host_user_id, host_timezone, base_price_cents, default_slot_duration_seconds, platform_fee_bps, created_at, updated_at)
      VALUES ($1, 'UTC', 5000, 1800, 500, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')
      ON CONFLICT (host_user_id) DO NOTHING`, [hostUserId]);
    await repoDb.unsafe(`INSERT INTO bookings.bookings (
        booking_id, hold_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc,
        gross_cents, platform_fee_bps, platform_fee_cents, host_payout_cents, refund_cents, status,
        funding_tx_ref, payout_tx_ref, refund_tx_ref, funding_wallet_address, host_payout_wallet_address,
        live_room_id, source_community_id, confirmed_at, completed_at, settled_at, cancelled_at, created_at, updated_at
      ) VALUES (
        $1, NULL, $2, $3, $4::timestamptz, $5::timestamptz,
        5000, 500, 250, 4750, NULL, $6,
        $7, NULL, NULL, '0xfunder', '0xpayout',
        NULL, 'community_lifecycle_service', '2026-06-10T10:02:00Z', NULL, NULL, NULL,
        '2026-06-10T10:02:00Z', '2026-06-10T10:02:00Z'
      )`, [
      input.bookingId,
      hostUserId,
      bookerUserId,
      input.slotStartUtc ?? "2026-07-01T10:00:00Z",
      input.slotEndUtc ?? "2026-07-01T11:00:00Z",
      input.status ?? "confirmed",
      `0xfunding_${input.bookingId}`,
    ]);
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

  afterEach(() => {
    setGlobalBookingAgoraBuilderForTests(null);
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

  test("starts confirmed bookings for either party, enforces window, and supports live replay", async () => {
    await seedBooking({ bookingId: "bkg_lifecycle_service_start" });
    await seedBooking({ bookingId: "bkg_lifecycle_service_too_early" });

    const started = await startGlobalBookingSession({
      executor: makeExecutor(repoDb),
      bookingId: "bkg_lifecycle_service_start",
      actorUserId: "host_bkg_lifecycle_service_start",
      nowUtc: "2026-07-01T09:56:00Z",
    });
    expect(started).toEqual({
      ok: true,
      already: false,
      booking: {
        booking_id: "bkg_lifecycle_service_start",
        status: "live",
        refund_cents: 0,
        refund_tx_ref: null,
        payout_tx_ref: null,
      },
    });

    expect(await startGlobalBookingSession({
      executor: makeExecutor(repoDb),
      bookingId: "bkg_lifecycle_service_start",
      actorUserId: "booker_bkg_lifecycle_service_start",
      nowUtc: "2026-07-01T09:57:00Z",
    })).toMatchObject({ ok: true, already: true });

    expect(await startGlobalBookingSession({
      executor: makeExecutor(repoDb),
      bookingId: "bkg_lifecycle_service_too_early",
      actorUserId: "host_bkg_lifecycle_service_too_early",
      nowUtc: "2026-07-01T09:54:59Z",
    })).toEqual({ ok: false, reason: "outside_start_window" });

    expect(await startGlobalBookingSession({
      executor: makeExecutor(repoDb),
      bookingId: "bkg_lifecycle_service_start",
      actorUserId: "stranger",
      nowUtc: "2026-07-01T09:57:00Z",
    })).toEqual({ ok: false, reason: "not_found" });
  });

  test("attaches session attendance, stores derived channel once, and accepts identity-bound heartbeat", async () => {
    await seedBooking({ bookingId: "bkg_lifecycle_service_attach", status: "live" });
    setGlobalBookingAgoraBuilderForTests(({ channel, uid }) => ({
      provider: "agora",
      channel,
      uid,
      token: `token:${channel}:${uid}`,
      expires_at: "2026-07-01T11:00:00Z",
    }));

    const attached = await attachGlobalBookingSession({
      env: {} as Env,
      executor: makeExecutor(repoDb),
      bookingId: "bkg_lifecycle_service_attach",
      actorUserId: "booker_bkg_lifecycle_service_attach",
      nowUtc: "2026-07-01T10:00:00Z",
    });
    expect(attached.ok).toBe(true);
    if (!attached.ok) throw new Error("expected attach");
    expect(attached.party).toBe("booker");
    expect(attached.channel).toBe("pirate-booking-bkg_lifecycle_service_attach");
    expect(attached.agora.token).toContain("pirate-booking-bkg_lifecycle_service_attach");

    const rows = await repoDb.unsafe(`SELECT b.live_room_id, s.party, s.user_id, s.agora_uid
      FROM bookings.bookings b
      JOIN bookings.attendance_sessions s ON s.booking_id = b.booking_id
      WHERE b.booking_id = $1`, ["bkg_lifecycle_service_attach"]) as Record<string, unknown>[];
    expect(rows.length).toBe(1);
    expect(rows[0].live_room_id).toBe("pirate-booking-bkg_lifecycle_service_attach");
    expect(rows[0].party).toBe("booker");
    expect(rows[0].user_id).toBe("booker_bkg_lifecycle_service_attach");

    expect(await heartbeatGlobalBookingSession({
      executor: makeExecutor(repoDb),
      bookingId: "bkg_lifecycle_service_attach",
      actorUserId: "host_bkg_lifecycle_service_attach",
      sessionId: attached.sessionId,
      nowUtc: "2026-07-01T10:00:10Z",
    })).toEqual({ ok: false, reason: "not_found" });

    expect(await heartbeatGlobalBookingSession({
      executor: makeExecutor(repoDb),
      bookingId: "bkg_lifecycle_service_attach",
      actorUserId: "booker_bkg_lifecycle_service_attach",
      sessionId: attached.sessionId,
      nowUtc: "2026-07-01T10:00:20Z",
    })).toEqual({ ok: true });
    const heartbeats = await repoDb.unsafe(`SELECT seen_at FROM bookings.attendance_heartbeats WHERE session_id = $1`, [attached.sessionId]) as Record<string, unknown>[];
    expect(String(heartbeats[0].seen_at)).toBe("2026-07-01 10:00:20+00");
  });

  test("rejects attach for non-parties and terminal bookings", async () => {
    await seedBooking({ bookingId: "bkg_lifecycle_service_done", status: "completed" });
    setGlobalBookingAgoraBuilderForTests(({ channel, uid }) => ({
      provider: "agora",
      channel,
      uid,
      token: "unused",
      expires_at: "2026-07-01T11:00:00Z",
    }));

    expect(await attachGlobalBookingSession({
      env: {} as Env,
      executor: makeExecutor(repoDb),
      bookingId: "bkg_lifecycle_service_done",
      actorUserId: "host_bkg_lifecycle_service_done",
      nowUtc: "2026-07-01T10:00:00Z",
    })).toEqual({ ok: false, reason: "not_attachable" });

    expect(await attachGlobalBookingSession({
      env: {} as Env,
      executor: makeExecutor(repoDb),
      bookingId: "bkg_lifecycle_service_done",
      actorUserId: "stranger",
      nowUtc: "2026-07-01T10:00:00Z",
    })).toEqual({ ok: false, reason: "not_found" });
  });
});
