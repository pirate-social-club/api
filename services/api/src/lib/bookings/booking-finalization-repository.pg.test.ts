// Real-Postgres tests for global booking finalization. Runs only when
// BOOKINGS_REPO_TEST_ADMIN_URL is set. Applies canonical core b0001 and validates the durable
// booking/hold/intent/slot-lock CAS against real constraints.
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveCoreRepoPath } from "../../../shared/core-repo-paths";
import {
  bookingIdForHold, createBookingFinalizationRepository, createBookingFinalizationTxWriteRepository,
  createBookingFinalizationWriteRepository, type BookingFinalizationSqlExecutor,
} from "./booking-finalization-repository";

const ADMIN_URL = process.env.BOOKINGS_REPO_TEST_ADMIN_URL;
const RUN = Boolean(ADMIN_URL);
const TEST_DB = "bookings_finalization_repo_test";

function urlFor(db?: string): string {
  const u = new URL(ADMIN_URL as string);
  if (db) u.pathname = `/${db}`;
  if (!u.searchParams.get("sslmode")) u.searchParams.set("sslmode", "disable");
  return u.toString();
}

function connect(db?: string): SQL {
  return new SQL({ url: urlFor(db), tls: false, max: 1, connectionTimeout: 5 } as Record<string, unknown>);
}

function makeExecutor(conn: { unsafe(sql: string, args?: unknown[]): Promise<unknown> }): BookingFinalizationSqlExecutor {
  const toPg = (s: string) => s.replace(/\?(\d+)/gu, (_m, i: string) => `$${i}`);
  return {
    async execute(statement) {
      const st = typeof statement === "string" ? { sql: statement, args: [] as unknown[] } : statement;
      const rows = (await conn.unsafe(toPg(st.sql), st.args ?? [])) as Record<string, unknown>[];
      return { rows };
    },
  };
}

describe.skipIf(!RUN)("bookings finalization repository (real Postgres)", () => {
  let repoDb: SQL;

  async function seedVerifiedIntent(input: {
    holdId: string;
    hostUserId?: string;
    bookerUserId?: string;
    status?: "active" | "consumed" | "expired";
    intentStatus?: "verified" | "consumed" | "active";
    sourceCommunityId?: string | null;
    fundingTxRef?: string;
    walletAttachmentId?: string;
    verifiedSenderAddress?: string;
  }): Promise<void> {
    const hostUserId = input.hostUserId ?? `host_${input.holdId}`;
    const bookerUserId = input.bookerUserId ?? `booker_${input.holdId}`;
    const fundingTxRef = input.fundingTxRef ?? `0xtx_${input.holdId}`;
    const walletAttachmentId = input.walletAttachmentId ?? `wallet_${input.holdId}`;
    const verifiedSenderAddress = input.verifiedSenderAddress ?? `0xsender_${input.holdId}`;
    await repoDb.unsafe(`INSERT INTO bookings.profiles
      (host_user_id, host_timezone, base_price_cents, default_slot_duration_seconds, payout_wallet_address, created_at, updated_at)
      VALUES ($1, 'UTC', 5000, 1800, '0xpayout', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')`, [hostUserId]);
    await repoDb.unsafe(`INSERT INTO bookings.holds
      (hold_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc, price_cents, status, source_community_id, expires_at_utc, created_at, updated_at)
      VALUES ($1, $2, $3, '2026-07-01T10:00:00Z', '2026-07-01T11:00:00Z', 5000, $4, $5, '2026-06-10T10:10:00Z', '2026-06-10T10:00:00Z', '2026-06-10T10:00:00Z')`,
    [input.holdId, hostUserId, bookerUserId, input.status ?? "active", input.sourceCommunityId ?? "community_final"]);
    await repoDb.unsafe(`INSERT INTO bookings.host_slot_locks
      (lock_id, host_user_id, slot_start_utc, slot_end_utc, hold_id, status, source_community_id, expires_at_utc, created_at, updated_at)
      VALUES ($1, $2, '2026-07-01T10:00:00Z', '2026-07-01T11:00:00Z', $3, 'active', $4, '2026-06-10T10:10:00Z', '2026-06-10T10:00:00Z', '2026-06-10T10:00:00Z')`,
    [`lock_${input.holdId}`, hostUserId, input.holdId, input.sourceCommunityId ?? "community_final"]);
    await repoDb.unsafe(`INSERT INTO bookings.payment_intents
      (payment_intent_id, hold_id, version, chain_id, token_address, token_decimals, token_symbol,
       recipient_address, amount_atomic, gross_cents, quote_expires_at, hold_expires_at,
       wallet_attachment_required, platform_fee_bps, platform_fee_cents, host_payout_cents,
       status, claimed_tx_ref, verified_sender_address, verified_at, consumed_wallet_attachment_id, created_at, updated_at)
      VALUES ($1, $2, 3, 8453, '0xtoken', 6, 'USDC', '0xrecipient', '50000000', 5000,
       '2026-06-10T10:10:00Z', '2026-06-10T10:10:00Z', true, 500, 250, 4750,
       $3, $4, $5, '2026-06-10T10:01:00Z', $6, '2026-06-10T10:00:00Z', '2026-06-10T10:01:00Z')`,
    [`pi_${input.holdId}`, input.holdId, input.intentStatus ?? "verified", fundingTxRef, verifiedSenderAddress, walletAttachmentId]);
  }

  function finalizationInput(holdId: string, overrides: Record<string, string> = {}) {
    return {
      holdId,
      paymentIntentId: `pi_${holdId}`,
      bookerUserId: `booker_${holdId}`,
      normalizedTxRef: `0xtx_${holdId}`,
      walletAttachmentId: `wallet_${holdId}`,
      verifiedSenderAddress: `0xsender_${holdId}`,
      hostPayoutWalletAddress: "0xpayout",
      nowUtc: "2026-06-10T10:02:00Z",
      ...overrides,
    };
  }

  function writeRepo() {
    return createBookingFinalizationWriteRepository(makeExecutor(repoDb));
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

  test("finalizes a verified intent into a booking, consumed hold, consumed intent, and permanent lock", async () => {
    await seedVerifiedIntent({ holdId: "hold_final_create", sourceCommunityId: "community_source" });
    const repo = writeRepo();

    const result = await repo.finalizeBookingFromVerifiedPaymentIntent(finalizationInput("hold_final_create"));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected finalization");
    expect(result.already).toBe(false);
    expect(result.booking.bookingId).toBe(bookingIdForHold("hold_final_create"));
    expect(result.booking.status).toBe("confirmed");
    expect(result.booking.platformFeeCents).toBe(250);
    expect(result.booking.hostPayoutCents).toBe(4750);
    expect(result.booking.sourceCommunityId).toBe("community_source");

    const rows = await repoDb.unsafe(`SELECT h.status AS hold_status, pi.status AS intent_status, pi.consumed_at,
        l.booking_id, l.expires_at_utc
      FROM bookings.holds h
      JOIN bookings.payment_intents pi ON pi.hold_id = h.hold_id
      JOIN bookings.host_slot_locks l ON l.hold_id = h.hold_id
      WHERE h.hold_id = $1`, ["hold_final_create"]) as Record<string, unknown>[];
    expect(rows[0].hold_status).toBe("consumed");
    expect(rows[0].intent_status).toBe("consumed");
    expect(rows[0].consumed_at).not.toBeNull();
    expect(rows[0].booking_id).toBe(bookingIdForHold("hold_final_create"));
    expect(rows[0].expires_at_utc).toBeNull();
  });

  test("replay returns the existing matching booking without creating a duplicate", async () => {
    await seedVerifiedIntent({ holdId: "hold_final_replay" });
    const repo = writeRepo();

    const first = await repo.finalizeBookingFromVerifiedPaymentIntent(finalizationInput("hold_final_replay"));
    expect(first.ok).toBe(true);
    const second = await repo.finalizeBookingFromVerifiedPaymentIntent(finalizationInput("hold_final_replay"));
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error("expected replay");
    expect(second.already).toBe(true);

    const count = await repoDb.unsafe(`SELECT count(*)::int AS n FROM bookings.bookings WHERE hold_id = $1`, ["hold_final_replay"]) as Record<string, unknown>[];
    expect(Number(count[0].n)).toBe(1);
  });

  test("mismatched replay and non-verified/consumed holds fail closed", async () => {
    await seedVerifiedIntent({ holdId: "hold_final_mismatch" });
    await seedVerifiedIntent({ holdId: "hold_final_unverified", intentStatus: "active" });
    await seedVerifiedIntent({ holdId: "hold_final_consumed_hold", status: "consumed" });
    const repo = writeRepo();

    expect((await repo.finalizeBookingFromVerifiedPaymentIntent(finalizationInput("hold_final_mismatch"))).ok).toBe(true);
    expect(await repo.finalizeBookingFromVerifiedPaymentIntent(finalizationInput("hold_final_mismatch", {
      normalizedTxRef: "0xdifferent",
    }))).toEqual({ ok: false, reason: "replay-conflict" });
    expect(await repo.finalizeBookingFromVerifiedPaymentIntent(finalizationInput("hold_final_unverified"))).toEqual({
      ok: false,
      reason: "finalization-conflict",
    });
    expect(await repo.finalizeBookingFromVerifiedPaymentIntent(finalizationInput("hold_final_consumed_hold"))).toEqual({
      ok: false,
      reason: "finalization-conflict",
    });
  });

  test("transaction-bound finalization rolls back all booking side effects", async () => {
    await seedVerifiedIntent({ holdId: "hold_final_rollback" });
    await expect(repoDb.begin(async (tx: { unsafe(sql: string, args?: unknown[]): Promise<unknown> }) => {
      const repo = createBookingFinalizationTxWriteRepository(makeExecutor(tx));
      const result = await repo.finalizeBookingFromVerifiedPaymentIntent(finalizationInput("hold_final_rollback"));
      expect(result.ok).toBe(true);
      throw new Error("rollback_probe");
    })).rejects.toThrow("rollback_probe");

    const read = createBookingFinalizationRepository(makeExecutor(repoDb));
    expect(await read.getBooking(bookingIdForHold("hold_final_rollback"))).toBeNull();
    const rows = await repoDb.unsafe(`SELECT h.status AS hold_status, pi.status AS intent_status, l.booking_id, l.expires_at_utc
      FROM bookings.holds h
      JOIN bookings.payment_intents pi ON pi.hold_id = h.hold_id
      JOIN bookings.host_slot_locks l ON l.hold_id = h.hold_id
      WHERE h.hold_id = $1`, ["hold_final_rollback"]) as Record<string, unknown>[];
    expect(rows[0].hold_status).toBe("active");
    expect(rows[0].intent_status).toBe("verified");
    expect(rows[0].booking_id).toBeNull();
    expect(rows[0].expires_at_utc).not.toBeNull();
  });
});
