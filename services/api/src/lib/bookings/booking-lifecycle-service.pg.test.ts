// Real-Postgres tests for global booking lifecycle service behavior that is route-facing:
// start, terminal settlement, session attach, and heartbeat. Runs only when
// BOOKINGS_REPO_TEST_ADMIN_URL is set and applies canonical core booking migrations.
import { SQL } from "bun";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Env } from "../../env";
import { applyCanonicalBookingMigrations } from "./test-migrations";
import type { BookingLifecycleSqlExecutor } from "./booking-lifecycle-repository";
import {
  attachGlobalBookingSession,
  cancelGlobalBooking,
  completeGlobalBooking,
  heartbeatGlobalBookingSession,
  markGlobalBookingSettlementAmbiguous,
  noShowGlobalBooking,
  resolveGlobalBookingSettlementReview,
  setGlobalBookingAgoraBuilderForTests,
  setGlobalBookingLifecycleDomainForTests,
  setGlobalBookingOperatorEffectExecutorForTests,
  startGlobalBookingSession,
} from "./booking-lifecycle-service";
import { createSettlementEffectWriteRepository } from "./settlement-effect-repository";

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
    lock?: boolean;
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
    if (input.lock) {
      await repoDb.unsafe(`INSERT INTO bookings.host_slot_locks
        (lock_id, host_user_id, slot_start_utc, slot_end_utc, booking_id, status, source_community_id, expires_at_utc, created_at, updated_at)
        VALUES ($1, $2, $3::timestamptz, $4::timestamptz, $5, 'active', 'community_lifecycle_service', NULL, '2026-06-10T10:02:00Z', '2026-06-10T10:02:00Z')`,
      [`lock_${input.bookingId}`, hostUserId, input.slotStartUtc ?? "2026-07-01T10:00:00Z", input.slotEndUtc ?? "2026-07-01T11:00:00Z", input.bookingId]);
    }
  }

  function installSettlementFakes(): void {
    setGlobalBookingLifecycleDomainForTests({
      canTransition(from, event) {
        return (
          (from === "confirmed" && (event === "HOST_CANCELS" || event === "BOOKER_CANCELS")) ||
          (from === "live" && (event === "SESSION_ENDED" || event === "HOST_NO_SHOW" || event === "BOOKER_NO_SHOW"))
        );
      },
      applyTransition(_from, event) {
        if (event === "HOST_CANCELS") return "cancelled_by_host";
        if (event === "BOOKER_CANCELS") return "cancelled_by_booker";
        if (event === "SESSION_ENDED") return "completed";
        if (event === "HOST_NO_SHOW") return "no_show_host";
        if (event === "BOOKER_NO_SHOW") return "no_show_booker";
        throw new Error(`unexpected_event:${event}`);
      },
      resolveRefund({ state, grossCents }) {
        return state === "cancelled_by_host" || state === "no_show_host" ? grossCents : 0;
      },
      retainedHostPayout({ grossCents, refundCents, platformFeeBps }) {
        const retained = Math.max(0, grossCents - refundCents);
        const fee = Math.floor((retained * platformFeeBps + 5000) / 10000);
        return retained - fee;
      },
    });
    setGlobalBookingOperatorEffectExecutorForTests(async (ctx, effect) => {
      const settlementRef = `0x${effect.kind}_${effect.bookingId}`;
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
    setGlobalBookingAgoraBuilderForTests(null);
    setGlobalBookingLifecycleDomainForTests(null);
    setGlobalBookingOperatorEffectExecutorForTests(null);
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
        outcome: null,
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
      app_id: "app_test",
      channel,
      uid,
      token: `token:${channel}:${uid}`,
      token_expires_at: 1_783_000_000,
      configured: true,
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
    const heartbeats = await repoDb.unsafe(`SELECT seen_at::text AS seen_at FROM bookings.attendance_heartbeats WHERE session_id = $1`, [attached.sessionId]) as Record<string, unknown>[];
    expect(String(heartbeats[0].seen_at)).toBe("2026-07-01 10:00:20+00");
  });

  test("settles global complete, cancel, and no-show with effects and lock release", async () => {
    installSettlementFakes();
    await seedBooking({ bookingId: "bkg_lifecycle_service_complete", status: "live", lock: true });
    await seedBooking({ bookingId: "bkg_lifecycle_service_cancel", status: "confirmed", lock: true });
    await seedBooking({ bookingId: "bkg_lifecycle_service_no_show", status: "live", lock: true });

    const completed = await completeGlobalBooking({
      env: {} as Env,
      executor: makeExecutor(repoDb),
      bookingId: "bkg_lifecycle_service_complete",
      actorUserId: "host_bkg_lifecycle_service_complete",
      nowUtc: "2026-07-01T10:30:00Z",
    });
    expect(completed).toMatchObject({
      ok: true,
      already: false,
      booking: {
        booking_id: "bkg_lifecycle_service_complete",
        status: "settled",
        payout_tx_ref: "0xpayout_bkg_lifecycle_service_complete",
      },
    });

    const cancelled = await cancelGlobalBooking({
      env: {} as Env,
      executor: makeExecutor(repoDb),
      bookingId: "bkg_lifecycle_service_cancel",
      actorUserId: "host_bkg_lifecycle_service_cancel",
      nowUtc: "2026-06-11T10:00:00Z",
    });
    expect(cancelled).toMatchObject({
      ok: true,
      already: false,
      cancelledBy: "host",
      booking: {
        booking_id: "bkg_lifecycle_service_cancel",
        status: "refunded",
        refund_cents: 5000,
        refund_tx_ref: "0xrefund_bkg_lifecycle_service_cancel",
      },
    });

    const noShow = await noShowGlobalBooking({
      env: {} as Env,
      executor: makeExecutor(repoDb),
      bookingId: "bkg_lifecycle_service_no_show",
      actorUserId: "booker_bkg_lifecycle_service_no_show",
      nowUtc: "2026-07-01T10:11:00Z",
    });
    expect(noShow).toMatchObject({
      ok: true,
      already: false,
      booking: {
        booking_id: "bkg_lifecycle_service_no_show",
        status: "refunded",
        refund_cents: 5000,
        refund_tx_ref: "0xrefund_bkg_lifecycle_service_no_show",
      },
    });

    const locks = await repoDb.unsafe(`SELECT booking_id, status FROM bookings.host_slot_locks
      WHERE booking_id IN ($1, $2, $3)
      ORDER BY booking_id`, [
      "bkg_lifecycle_service_cancel",
      "bkg_lifecycle_service_complete",
      "bkg_lifecycle_service_no_show",
    ]) as Record<string, unknown>[];
    expect(locks.map((row) => row.status)).toEqual(["released", "released", "released"]);

    const effects = await repoDb.unsafe(`SELECT booking_id, effect_kind, status, settlement_ref FROM bookings.settlement_effects
      WHERE booking_id IN ($1, $2, $3)
      ORDER BY booking_id, effect_kind`, [
      "bkg_lifecycle_service_cancel",
      "bkg_lifecycle_service_complete",
      "bkg_lifecycle_service_no_show",
    ]) as Record<string, unknown>[];
    expect(effects).toEqual([
      {
        booking_id: "bkg_lifecycle_service_cancel",
        effect_kind: "booking_refund",
        status: "confirmed",
        settlement_ref: "0xrefund_bkg_lifecycle_service_cancel",
      },
      {
        booking_id: "bkg_lifecycle_service_complete",
        effect_kind: "booking_payout",
        status: "confirmed",
        settlement_ref: "0xpayout_bkg_lifecycle_service_complete",
      },
      {
        booking_id: "bkg_lifecycle_service_no_show",
        effect_kind: "booking_refund",
        status: "confirmed",
        settlement_ref: "0xrefund_bkg_lifecycle_service_no_show",
      },
    ]);
  });

  test("opens and resolves ambiguous settlement reviews with version CAS and replay semantics", async () => {
    installSettlementFakes();
    await seedBooking({ bookingId: "bkg_lifecycle_service_review", status: "live", lock: true });
    await seedBooking({ bookingId: "bkg_lifecycle_service_review_conflict", status: "live" });

    const marked = await markGlobalBookingSettlementAmbiguous({
      executor: makeExecutor(repoDb),
      bookingId: "bkg_lifecycle_service_review",
      nowUtc: "2026-07-01T11:20:00Z",
    });
    expect(marked).toEqual({ ok: true, already: false, reviewVersion: 1 });

    expect(await markGlobalBookingSettlementAmbiguous({
      executor: makeExecutor(repoDb),
      bookingId: "bkg_lifecycle_service_review",
      nowUtc: "2026-07-01T11:21:00Z",
    })).toEqual({ ok: true, already: true, reviewVersion: 1 });

    const pending = await repoDb.unsafe(`SELECT status, settlement_review_status, settlement_review_reason,
        settlement_review_resolution, settlement_review_version, settlement_review_opened_at::text AS opened_at
      FROM bookings.bookings
      WHERE booking_id = $1`, ["bkg_lifecycle_service_review"]) as Record<string, unknown>[];
    expect(pending[0]).toMatchObject({
      status: "disputed",
      settlement_review_status: "pending",
      settlement_review_reason: "attendance_ambiguous",
      settlement_review_resolution: null,
      settlement_review_version: 1,
      opened_at: "2026-07-01 11:20:00+00",
    });

    expect(await resolveGlobalBookingSettlementReview({
      env: {} as Env,
      executor: makeExecutor(repoDb),
      bookingId: "bkg_lifecycle_service_review",
      resolution: "completed",
      expectedReviewVersion: 0,
      operatorCredentialId: "op_cred",
      operatorActorId: "op_actor",
      nowUtc: "2026-07-01T11:25:00Z",
      confirmPollMs: [],
    })).toEqual({ ok: false, reason: "version_conflict" });

    const resolved = await resolveGlobalBookingSettlementReview({
      env: {} as Env,
      executor: makeExecutor(repoDb),
      bookingId: "bkg_lifecycle_service_review",
      resolution: "completed",
      expectedReviewVersion: 1,
      operatorCredentialId: "op_cred",
      operatorActorId: "op_actor",
      note: "attendance reviewed",
      nowUtc: "2026-07-01T11:25:00Z",
      confirmPollMs: [],
    });
    expect(resolved).toMatchObject({
      ok: true,
      outcome: "resolved",
      booking: {
        booking_id: "bkg_lifecycle_service_review",
        status: "settled",
        refund_cents: 0,
        payout_tx_ref: "0xpayout_bkg_lifecycle_service_review",
      },
    });

    const review = await repoDb.unsafe(`SELECT status, settlement_review_status, settlement_review_resolution,
        settlement_review_version, settlement_review_operator_credential_id, settlement_review_operator_actor_id,
        settlement_review_note, settlement_review_resolved_at::text AS resolved_at
      FROM bookings.bookings
      WHERE booking_id = $1`, ["bkg_lifecycle_service_review"]) as Record<string, unknown>[];
    expect(review[0]).toMatchObject({
      status: "settled",
      settlement_review_status: "resolved",
      settlement_review_resolution: "completed",
      settlement_review_version: 2,
      settlement_review_operator_credential_id: "op_cred",
      settlement_review_operator_actor_id: "op_actor",
      settlement_review_note: "attendance reviewed",
      resolved_at: "2026-07-01 11:25:00+00",
    });

    expect(await resolveGlobalBookingSettlementReview({
      env: {} as Env,
      executor: makeExecutor(repoDb),
      bookingId: "bkg_lifecycle_service_review",
      resolution: "completed",
      expectedReviewVersion: 1,
      operatorCredentialId: "op_cred",
      operatorActorId: "op_actor",
      nowUtc: "2026-07-01T11:26:00Z",
      confirmPollMs: [],
    })).toMatchObject({ ok: true, outcome: "replayed" });

    expect(await resolveGlobalBookingSettlementReview({
      env: {} as Env,
      executor: makeExecutor(repoDb),
      bookingId: "bkg_lifecycle_service_review",
      resolution: "no_show_host",
      expectedReviewVersion: 1,
      operatorCredentialId: "op_cred",
      operatorActorId: "op_actor",
      nowUtc: "2026-07-01T11:26:00Z",
      confirmPollMs: [],
    })).toEqual({ ok: false, reason: "resolution_conflict" });

    await markGlobalBookingSettlementAmbiguous({
      executor: makeExecutor(repoDb),
      bookingId: "bkg_lifecycle_service_review_conflict",
      nowUtc: "2026-07-01T11:30:00Z",
    });
    expect(await resolveGlobalBookingSettlementReview({
      env: {} as Env,
      executor: makeExecutor(repoDb),
      bookingId: "bkg_lifecycle_service_review_conflict",
      resolution: "no_show_host",
      expectedReviewVersion: 1,
      operatorCredentialId: "op_cred",
      operatorActorId: "op_actor",
      nowUtc: "2026-07-01T11:35:00Z",
      confirmPollMs: [],
    })).toMatchObject({
      ok: true,
      outcome: "resolved",
      booking: {
        status: "refunded",
        refund_cents: 5000,
        refund_tx_ref: "0xrefund_bkg_lifecycle_service_review_conflict",
      },
    });
  });

  test("rejects attach for non-parties and terminal bookings", async () => {
    await seedBooking({ bookingId: "bkg_lifecycle_service_done", status: "completed" });
    setGlobalBookingAgoraBuilderForTests(({ channel, uid }) => ({
      app_id: "app_test",
      channel,
      uid,
      token: "unused",
      token_expires_at: 1_783_000_000,
      configured: true,
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
