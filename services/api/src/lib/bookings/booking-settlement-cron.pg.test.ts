// Real-Postgres tests for the global booking settlement cron. Runs only when
// BOOKINGS_REPO_TEST_ADMIN_URL is set. Applies canonical core booking migrations and validates due attendance
// resolution plus unfinished-intent resume against bookings.* rows.
import { SQL } from "bun";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Env } from "../../env";
import { applyCanonicalBookingMigrations } from "./test-migrations";
import type { Client, InStatement, QueryResult } from "../sql-client";
import {
  setGlobalBookingLifecycleDomainForTests,
  setGlobalBookingOperatorEffectExecutorForTests,
} from "./booking-lifecycle-service";
import { sweepGlobalBookingSettlements } from "./booking-settlement-cron";
import { createSettlementEffectWriteRepository } from "./settlement-effect-repository";

const ADMIN_URL = process.env.BOOKINGS_REPO_TEST_ADMIN_URL;
const RUN = Boolean(ADMIN_URL);
const TEST_DB = "bookings_settlement_cron_test";

function urlFor(db?: string): string {
  const u = new URL(ADMIN_URL as string);
  if (db) u.pathname = `/${db}`;
  if (!u.searchParams.get("sslmode")) u.searchParams.set("sslmode", "disable");
  return u.toString();
}

function connect(db?: string): SQL {
  return new SQL({ url: urlFor(db), tls: false, max: 1, connectionTimeout: 5 } as Record<string, unknown>);
}

function makeClient(conn: { unsafe(sql: string, args?: unknown[]): Promise<unknown> }): Client {
  const toPg = (s: string) => s.replace(/\?(\d+)/gu, (_m, i: string) => `$${i}`);
  return {
    async execute(statement: InStatement | string): Promise<QueryResult> {
      const st = typeof statement === "string" ? { sql: statement, args: [] as unknown[] } : statement;
      const rows = (await conn.unsafe(toPg(st.sql), st.args ?? [])) as Record<string, unknown>[];
      return { rows };
    },
    async batch(statements) {
      const results: QueryResult[] = [];
      for (const statement of statements) results.push(await this.execute(statement));
      return results;
    },
    async transaction() {
      throw new Error("transaction_not_used");
    },
  };
}

describe.skipIf(!RUN)("global booking settlement cron (real Postgres)", () => {
  let repoDb: SQL;

  async function seedBooking(input: {
    bookingId: string;
    status: "confirmed" | "live" | "completed";
    refundCents?: number | null;
  }): Promise<void> {
    const hostUserId = `host_${input.bookingId}`;
    const bookerUserId = `booker_${input.bookingId}`;
    await repoDb.unsafe(`INSERT INTO bookings.profiles
      (host_user_id, host_timezone, base_price_cents, default_slot_duration_seconds, platform_fee_bps, payout_wallet_address, created_at, updated_at)
      VALUES ($1, 'UTC', 5000, 1800, 500, '0x1111111111111111111111111111111111111111', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')`,
    [hostUserId]);
    await repoDb.unsafe(`INSERT INTO bookings.bookings (
        booking_id, hold_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc,
        gross_cents, platform_fee_bps, platform_fee_cents, host_payout_cents, refund_cents, status,
        funding_tx_ref, payout_tx_ref, refund_tx_ref, funding_wallet_address, host_payout_wallet_address,
        live_room_id, source_community_id, confirmed_at, completed_at, settled_at, cancelled_at, created_at, updated_at
      ) VALUES (
        $1, NULL, $2, $3, '2026-07-01T10:00:00Z', '2026-07-01T11:00:00Z',
        5000, 500, 250, 4750, $4, $5,
        $6, NULL, NULL, '0x2222222222222222222222222222222222222222', '0x1111111111111111111111111111111111111111',
        NULL, 'community_global_cron', '2026-06-10T10:02:00Z',
        CASE WHEN $5 = 'completed' THEN '2026-07-01T11:00:00Z'::timestamptz ELSE NULL END,
        NULL, NULL, '2026-06-10T10:02:00Z', '2026-06-10T10:02:00Z'
      )`, [input.bookingId, hostUserId, bookerUserId, input.refundCents ?? null, input.status, `0xfunding_${input.bookingId}`]);
    await repoDb.unsafe(`INSERT INTO bookings.host_slot_locks
      (lock_id, host_user_id, slot_start_utc, slot_end_utc, booking_id, status, source_community_id, expires_at_utc, created_at, updated_at)
      VALUES ($1, $2, '2026-07-01T10:00:00Z', '2026-07-01T11:00:00Z', $3, 'active', 'community_global_cron', NULL, '2026-06-10T10:02:00Z', '2026-06-10T10:02:00Z')`,
    [`lock_${input.bookingId}`, hostUserId, input.bookingId]);
  }

  async function seedAttendance(bookingId: string, party: "host" | "booker", userId: string): Promise<void> {
    await repoDb.unsafe(`INSERT INTO bookings.attendance_sessions
      (session_id, booking_id, party, user_id, agora_uid, attached_at, last_seen_at, ended_at, created_at, updated_at)
      VALUES ($1, $2, $3, $4, NULL, '2026-07-01T10:00:00Z', '2026-07-01T10:30:00Z', NULL, '2026-07-01T10:00:00Z', '2026-07-01T10:30:00Z')`,
    [`bas_${bookingId}_${party}`, bookingId, party, userId]);
    for (let minute = 1; minute <= 10; minute += 1) {
      const seenAt = `2026-07-01T10:${String(minute).padStart(2, "0")}:00Z`;
      await repoDb.unsafe(`INSERT INTO bookings.attendance_heartbeats
        (heartbeat_id, session_id, booking_id, seen_at)
        VALUES ($1, $2, $3, $4::timestamptz)`,
      [`bah_${bookingId}_${party}_${minute}`, `bas_${bookingId}_${party}`, bookingId, seenAt]);
    }
  }

  function installFakes(): void {
    setGlobalBookingLifecycleDomainForTests({
      canTransition(from, event) {
        return (
          (from === "confirmed" && event === "SESSION_STARTED") ||
          (from === "live" && (event === "SESSION_ENDED" || event === "HOST_NO_SHOW" || event === "BOOKER_NO_SHOW"))
        );
      },
      applyTransition(_from, event) {
        if (event === "SESSION_ENDED") return "completed";
        if (event === "HOST_NO_SHOW") return "no_show_host";
        if (event === "BOOKER_NO_SHOW") return "no_show_booker";
        if (event === "SESSION_STARTED") return "live";
        throw new Error(`unexpected_event:${event}`);
      },
      resolveRefund({ state, grossCents }) {
        return state === "no_show_host" ? grossCents : 0;
      },
      retainedHostPayout({ grossCents, refundCents, platformFeeBps }) {
        const retained = Math.max(0, grossCents - refundCents);
        const fee = Math.floor((retained * platformFeeBps + 5000) / 10000);
        return retained - fee;
      },
    });
    setGlobalBookingOperatorEffectExecutorForTests(async (ctx, effect) => {
      const settlementRef = `0xcron_${effect.kind}_${effect.bookingId}`;
      const repo = createSettlementEffectWriteRepository(ctx.executor);
      const begun = await repo.beginSettlementEffectAttempt({
        bookingId: effect.bookingId,
        effectKind: effect.kind === "refund" ? "booking_refund" : "booking_payout",
        idempotencyKey: effect.idempotencyKey,
        amountCents: effect.amountCents,
        recipientAddress: effect.recipientAddress,
        nowUtc: ctx.nowUtc,
      });
      if (!begun.ok) throw new Error(`effect_begin_failed:${begun.reason}`);
      await repo.mirrorSettlementCoordinatorEffect({
        idempotencyKey: effect.idempotencyKey,
        coordinatorRef: `coord_${effect.idempotencyKey}`,
        coordinatorState: "broadcast",
        settlementRef,
        broadcastNonce: 1,
        nowUtc: ctx.nowUtc,
      });
      await repo.confirmSettlementEffect(effect.idempotencyKey, settlementRef, ctx.nowUtc);
      return { txRef: settlementRef };
    });
  }

  beforeAll(async () => {
    const root = connect();
    await root.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await root.unsafe(`CREATE DATABASE ${TEST_DB}`);
    await root.end();

    const db = connect(TEST_DB);
    for (const role of ["control_plane_api_rw", "control_plane_api_ro"]) {
      await db.unsafe(`DROP ROLE IF EXISTS ${role}`);
      await db.unsafe(`CREATE ROLE ${role} NOLOGIN`);
    }
    await db.unsafe("CREATE EXTENSION IF NOT EXISTS btree_gist");
    await applyCanonicalBookingMigrations(db);
    await db.end();

    repoDb = connect(TEST_DB);
  });

  afterEach(() => {
    setGlobalBookingLifecycleDomainForTests(null);
    setGlobalBookingOperatorEffectExecutorForTests(null);
  });

  afterAll(async () => {
    if (repoDb) await repoDb.end();
    const root = connect();
    await root.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {});
    for (const role of ["control_plane_api_rw", "control_plane_api_ro"]) {
      await root.unsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => {});
    }
    await root.end();
  });

  test("initiates due attendance outcomes and resumes unfinished settlement intents", async () => {
    installFakes();
    await seedBooking({ bookingId: "bkg_cron_completed", status: "confirmed" });
    await seedAttendance("bkg_cron_completed", "host", "host_bkg_cron_completed");
    await seedAttendance("bkg_cron_completed", "booker", "booker_bkg_cron_completed");

    await seedBooking({ bookingId: "bkg_cron_no_show_host", status: "live" });
    await seedAttendance("bkg_cron_no_show_host", "booker", "booker_bkg_cron_no_show_host");

    await seedBooking({ bookingId: "bkg_cron_resume", status: "completed", refundCents: 0 });

    const summary = await sweepGlobalBookingSettlements({
      env: { BOOKINGS_SETTLEMENT_CRON_ENABLED: "true" } as Env,
      client: makeClient(repoDb),
      now: () => Date.parse("2026-07-01T11:05:00Z"),
    });

    expect(summary).toMatchObject({
      enabled: true,
      checkedDue: 2,
      checkedResume: 1,
      initiated: 2,
      resumed: 1,
      settled: 3,
      errors: 0,
      fatal: false,
    });

    const bookings = await repoDb.unsafe(`SELECT booking_id, status, payout_tx_ref, refund_tx_ref FROM bookings.bookings
      WHERE booking_id IN ('bkg_cron_completed', 'bkg_cron_no_show_host', 'bkg_cron_resume')
      ORDER BY booking_id`) as Record<string, unknown>[];
    expect(bookings).toEqual([
      {
        booking_id: "bkg_cron_completed",
        status: "settled",
        payout_tx_ref: "0xcron_payout_bkg_cron_completed",
        refund_tx_ref: null,
      },
      {
        booking_id: "bkg_cron_no_show_host",
        status: "refunded",
        payout_tx_ref: null,
        refund_tx_ref: "0xcron_refund_bkg_cron_no_show_host",
      },
      {
        booking_id: "bkg_cron_resume",
        status: "settled",
        payout_tx_ref: "0xcron_payout_bkg_cron_resume",
        refund_tx_ref: null,
      },
    ]);

    const locks = await repoDb.unsafe(`SELECT status FROM bookings.host_slot_locks
      WHERE booking_id IN ('bkg_cron_completed', 'bkg_cron_no_show_host', 'bkg_cron_resume')
      ORDER BY booking_id`) as Record<string, unknown>[];
    expect(locks.map((row) => row.status)).toEqual(["released", "released", "released"]);
  });

  test("flags ambiguous due bookings as disputed without moving money and does not reselect them", async () => {
    installFakes();
    await seedBooking({ bookingId: "bkg_cron_ambiguous", status: "confirmed" });

    const first = await sweepGlobalBookingSettlements({
      env: { BOOKINGS_SETTLEMENT_CRON_ENABLED: "true" } as Env,
      client: makeClient(repoDb),
      now: () => Date.parse("2026-07-01T11:05:00Z"),
    });
    expect(first).toMatchObject({
      enabled: true,
      checkedDue: 1,
      checkedResume: 0,
      initiated: 0,
      resumed: 0,
      settled: 0,
      ambiguous: 1,
      errors: 0,
      fatal: false,
    });

    const bookings = await repoDb.unsafe(`SELECT status, payout_tx_ref, refund_tx_ref FROM bookings.bookings
      WHERE booking_id = $1`, ["bkg_cron_ambiguous"]) as Record<string, unknown>[];
    expect(bookings).toEqual([{
      status: "disputed",
      payout_tx_ref: null,
      refund_tx_ref: null,
    }]);

    const effects = await repoDb.unsafe(`SELECT effect_kind FROM bookings.settlement_effects
      WHERE booking_id = $1`, ["bkg_cron_ambiguous"]) as Record<string, unknown>[];
    expect(effects).toEqual([]);

    const second = await sweepGlobalBookingSettlements({
      env: { BOOKINGS_SETTLEMENT_CRON_ENABLED: "true" } as Env,
      client: makeClient(repoDb),
      now: () => Date.parse("2026-07-01T11:06:00Z"),
    });
    expect(second).toMatchObject({
      enabled: true,
      checkedDue: 0,
      checkedResume: 0,
      initiated: 0,
      resumed: 0,
      settled: 0,
      ambiguous: 0,
      errors: 0,
      fatal: false,
    });
  });
});
