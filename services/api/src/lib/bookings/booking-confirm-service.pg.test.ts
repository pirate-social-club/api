// Real-Postgres tests for the global booking quote/confirm service. Runs only when
// BOOKINGS_REPO_TEST_ADMIN_URL is set. Applies canonical core booking migrations and drives payment verification
// through the service seam so the durable state machine is tested without RPC.
import { SQL } from "bun";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Env } from "../../env";
import type { UserRepository } from "../auth/repositories";
import { applyCanonicalBookingMigrations } from "./test-migrations";
import {
  confirmGlobalBookingHold,
  quoteGlobalBookingHold,
  setGlobalBookingPaymentVerifierForTests,
  type BookingConfirmSqlExecutor,
} from "./booking-confirm-service";
import { bookingIdForHold } from "./booking-finalization-repository";
import { paymentIntentIdForHold } from "./payment-intent-repository";

const ADMIN_URL = process.env.BOOKINGS_REPO_TEST_ADMIN_URL;
const RUN = Boolean(ADMIN_URL);
const TEST_DB = "bookings_confirm_service_test";
const BUYER = "0x7000000000000000000000000000000000000007";
const OPERATOR = "0x1000000000000000000000000000000000000001";
const TOKEN = "0x2000000000000000000000000000000000000002";

const env = {
  PIRATE_CHECKOUT_SOURCE_CHAIN_ID: "84532",
  PIRATE_CHECKOUT_OPERATOR_ADDRESS: OPERATOR,
  PIRATE_CHECKOUT_USDC_TOKEN_ADDRESS: TOKEN,
} as Env;

function urlFor(db?: string): string {
  const u = new URL(ADMIN_URL as string);
  if (db) u.pathname = `/${db}`;
  if (!u.searchParams.get("sslmode")) u.searchParams.set("sslmode", "disable");
  return u.toString();
}

function connect(db?: string): SQL {
  return new SQL({ url: urlFor(db), tls: false, max: 1, connectionTimeout: 5 } as Record<string, unknown>);
}

function makeExecutor(conn: { unsafe(sql: string, args?: unknown[]): Promise<unknown> }): BookingConfirmSqlExecutor {
  const toPg = (s: string) => s.replace(/\?(\d+)/gu, (_m, i: string) => `$${i}`);
  return {
    async execute(statement) {
      const st = typeof statement === "string" ? { sql: statement, args: [] as unknown[] } : statement;
      const rows = (await conn.unsafe(toPg(st.sql), st.args ?? [])) as Record<string, unknown>[];
      return { rows };
    },
  };
}

function userRepository(walletAttachmentId = "wal_confirm", walletAddress = BUYER): UserRepository {
  return {
    async getUserById() {
      return null;
    },
    async getWalletAttachmentsByUserId(userId: string) {
      return [{
        wallet_attachment: walletAttachmentId,
        chain_namespace: "eip155",
        wallet_address: walletAddress,
        is_primary: true,
        user_id: userId,
        status: "verified",
      }];
    },
    async getWalletAttachmentById() {
      return null;
    },
    async setIdentityWallet() {
      return null;
    },
  } as UserRepository;
}

describe.skipIf(!RUN)("global booking confirm service (real Postgres)", () => {
  let repoDb: SQL;

  async function seedHold(input: {
    holdId: string;
    hostUserId?: string;
    bookerUserId?: string;
    payoutWalletAddress?: string | null;
    status?: "active" | "consumed" | "expired";
    expiresAtUtc?: string;
  }): Promise<void> {
    const hostUserId = input.hostUserId ?? `host_${input.holdId}`;
    const bookerUserId = input.bookerUserId ?? `booker_${input.holdId}`;
    const expiresAtUtc = input.expiresAtUtc ?? "2026-07-01T09:59:00Z";
    await repoDb.unsafe(`INSERT INTO bookings.profiles
      (host_user_id, host_timezone, base_price_cents, default_slot_duration_seconds, platform_fee_bps, payout_wallet_address, created_at, updated_at)
      VALUES ($1, 'UTC', 5000, 1800, 500, $2, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')`,
    [hostUserId, input.payoutWalletAddress === undefined ? "0x3000000000000000000000000000000000000003" : input.payoutWalletAddress]);
    await repoDb.unsafe(`INSERT INTO bookings.holds
      (hold_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc, price_cents, status, source_community_id, expires_at_utc, created_at, updated_at)
      VALUES ($1, $2, $3, '2026-07-01T10:00:00Z', '2026-07-01T11:00:00Z', 5000, $4, 'community_confirm', $5, '2026-07-01T09:49:00Z', '2026-07-01T09:49:00Z')`,
    [input.holdId, hostUserId, bookerUserId, input.status ?? "active", expiresAtUtc]);
    await repoDb.unsafe(`INSERT INTO bookings.host_slot_locks
      (lock_id, host_user_id, slot_start_utc, slot_end_utc, hold_id, status, source_community_id, expires_at_utc, created_at, updated_at)
      VALUES ($1, $2, '2026-07-01T10:00:00Z', '2026-07-01T11:00:00Z', $3, 'active', 'community_confirm', $4, '2026-07-01T09:49:00Z', '2026-07-01T09:49:00Z')`,
    [`lock_${input.holdId}`, hostUserId, input.holdId, expiresAtUtc]);
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
    setGlobalBookingPaymentVerifierForTests(null);
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

  test("quotes an active global hold with a durable payment intent and fee snapshot", async () => {
    await seedHold({ holdId: "hold_confirm_quote" });

    const result = await quoteGlobalBookingHold({
      env,
      executor: makeExecutor(repoDb),
      holdId: "hold_confirm_quote",
      nowUtc: "2026-07-01T09:50:00Z",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected quote");
    expect(result.quote.platform_fee_bps).toBe(500);
    expect(result.quote.platform_fee_cents).toBe(250);
    expect(result.quote.host_payout_cents).toBe(4750);
    expect(result.quote.payment.payment_intent_id).toBe(paymentIntentIdForHold("hold_confirm_quote"));
    expect(result.quote.payment.amount_atomic).toBe("50000000");
    expect(result.quote.payment.recipient_address).toBe(OPERATOR);
  });

  test("verifies payment, finalizes booking, consumes hold and intent, and supports exact replay", async () => {
    await seedHold({ holdId: "hold_confirm_success" });
    setGlobalBookingPaymentVerifierForTests(async ({ fundingTxRef }) => ({
      kind: "verified",
      senderAddress: BUYER,
      txRef: fundingTxRef,
    }));

    const first = await confirmGlobalBookingHold({
      env,
      executor: makeExecutor(repoDb),
      userRepository: userRepository("wal_confirm_success"),
      holdId: "hold_confirm_success",
      bookerUserId: "booker_hold_confirm_success",
      fundingTxRef: "0xTX_SUCCESS",
      walletAttachmentId: "wal_confirm_success",
      nowUtc: "2026-07-01T09:51:00Z",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected confirm");
    expect(first.already).toBe(false);
    expect(first.booking.booking_id).toBe(bookingIdForHold("hold_confirm_success"));
    expect(first.booking.status).toBe("confirmed");
    expect(first.booking.funding_tx_ref).toBe("0xtx_success");

    const rows = await repoDb.unsafe(`SELECT h.status AS hold_status, pi.status AS intent_status, l.booking_id, l.expires_at_utc
      FROM bookings.holds h
      JOIN bookings.payment_intents pi ON pi.hold_id = h.hold_id
      JOIN bookings.host_slot_locks l ON l.hold_id = h.hold_id
      WHERE h.hold_id = $1`, ["hold_confirm_success"]) as Record<string, unknown>[];
    expect(rows[0].hold_status).toBe("consumed");
    expect(rows[0].intent_status).toBe("consumed");
    expect(rows[0].booking_id).toBe(bookingIdForHold("hold_confirm_success"));
    expect(rows[0].expires_at_utc).toBeNull();

    const replay = await confirmGlobalBookingHold({
      env,
      executor: makeExecutor(repoDb),
      userRepository: userRepository("wal_confirm_success"),
      holdId: "hold_confirm_success",
      bookerUserId: "booker_hold_confirm_success",
      fundingTxRef: "0xTX_SUCCESS",
      walletAttachmentId: "wal_confirm_success",
      nowUtc: "2026-07-01T09:52:00Z",
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("expected replay");
    expect(replay.already).toBe(true);

    expect(await confirmGlobalBookingHold({
      env,
      executor: makeExecutor(repoDb),
      userRepository: userRepository("wal_different"),
      holdId: "hold_confirm_success",
      bookerUserId: "booker_hold_confirm_success",
      fundingTxRef: "0xTX_SUCCESS",
      walletAttachmentId: "wal_different",
      nowUtc: "2026-07-01T09:53:00Z",
    })).toEqual({ ok: false, reason: "replay_mismatch" });
  });

  test("pending verification records a retryable failed intent and can later resume with the same tx", async () => {
    await seedHold({ holdId: "hold_confirm_pending" });
    setGlobalBookingPaymentVerifierForTests(async () => ({ kind: "pending" }));

    expect(await confirmGlobalBookingHold({
      env,
      executor: makeExecutor(repoDb),
      userRepository: userRepository("wal_confirm_pending"),
      holdId: "hold_confirm_pending",
      bookerUserId: "booker_hold_confirm_pending",
      fundingTxRef: "0xTX_PENDING",
      walletAttachmentId: "wal_confirm_pending",
      nowUtc: "2026-07-01T09:51:00Z",
    })).toEqual({ ok: false, reason: "payment_pending" });

    const failed = await repoDb.unsafe(`SELECT status, claimed_tx_ref, consumed_wallet_attachment_id
      FROM bookings.payment_intents WHERE payment_intent_id = $1`, [paymentIntentIdForHold("hold_confirm_pending")]) as Record<string, unknown>[];
    expect(failed[0].status).toBe("verification_failed");
    expect(failed[0].claimed_tx_ref).toBe("0xtx_pending");
    expect(failed[0].consumed_wallet_attachment_id).toBe("wal_confirm_pending");

    setGlobalBookingPaymentVerifierForTests(async ({ fundingTxRef }) => ({
      kind: "verified",
      senderAddress: BUYER,
      txRef: fundingTxRef,
    }));
    const resumed = await confirmGlobalBookingHold({
      env,
      executor: makeExecutor(repoDb),
      userRepository: userRepository("wal_confirm_pending"),
      holdId: "hold_confirm_pending",
      bookerUserId: "booker_hold_confirm_pending",
      fundingTxRef: "0xTX_PENDING",
      walletAttachmentId: "wal_confirm_pending",
      nowUtc: "2026-07-01T09:52:00Z",
    });
    expect(resumed.ok).toBe(true);
  });

  test("rejected payments and missing payout wallets fail closed", async () => {
    await seedHold({ holdId: "hold_confirm_rejected" });
    await seedHold({ holdId: "hold_confirm_no_payout", payoutWalletAddress: null });
    setGlobalBookingPaymentVerifierForTests(async () => ({ kind: "rejected", reason: "no_matching_transfer" }));

    expect(await confirmGlobalBookingHold({
      env,
      executor: makeExecutor(repoDb),
      userRepository: userRepository("wal_confirm_rejected"),
      holdId: "hold_confirm_rejected",
      bookerUserId: "booker_hold_confirm_rejected",
      fundingTxRef: "0xTX_REJECTED",
      walletAttachmentId: "wal_confirm_rejected",
      nowUtc: "2026-07-01T09:51:00Z",
    })).toEqual({ ok: false, reason: "payment_rejected" });

    setGlobalBookingPaymentVerifierForTests(async ({ fundingTxRef }) => ({
      kind: "verified",
      senderAddress: BUYER,
      txRef: fundingTxRef,
    }));
    expect(await confirmGlobalBookingHold({
      env,
      executor: makeExecutor(repoDb),
      userRepository: userRepository("wal_confirm_no_payout"),
      holdId: "hold_confirm_no_payout",
      bookerUserId: "booker_hold_confirm_no_payout",
      fundingTxRef: "0xTX_NO_PAYOUT",
      walletAttachmentId: "wal_confirm_no_payout",
      nowUtc: "2026-07-01T09:51:00Z",
    })).toEqual({ ok: false, reason: "host_payout_unconfigured" });
    expect((await repoDb.unsafe(`SELECT count(*)::int AS n FROM bookings.bookings WHERE hold_id = $1`, ["hold_confirm_no_payout"]) as Record<string, unknown>[])[0].n).toBe(0);
  });
});
