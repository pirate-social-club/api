// Real-Postgres tests for global bookings payment intents. Runs only when
// BOOKINGS_REPO_TEST_ADMIN_URL is set. Applies canonical core b0001 and exercises CAS transitions
// against the actual bookings.payment_intents constraints.
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveCoreRepoPath } from "../../../shared/core-repo-paths";
import {
  createPaymentIntentRepository, createPaymentIntentTxWriteRepository, createPaymentIntentWriteRepository,
  normalizeTxRef, paymentIntentIdForHold, type CreatePaymentIntentInput, type PaymentIntentSqlExecutor,
} from "./payment-intent-repository";

const ADMIN_URL = process.env.BOOKINGS_REPO_TEST_ADMIN_URL;
const RUN = Boolean(ADMIN_URL);
const TEST_DB = "bookings_payment_intent_repo_test";

function urlFor(db?: string): string {
  const u = new URL(ADMIN_URL as string);
  if (db) u.pathname = `/${db}`;
  if (!u.searchParams.get("sslmode")) u.searchParams.set("sslmode", "disable");
  return u.toString();
}

function connect(db?: string): SQL {
  return new SQL({ url: urlFor(db), tls: false, max: 1, connectionTimeout: 5 } as Record<string, unknown>);
}

function makeExecutor(conn: { unsafe(sql: string, args?: unknown[]): Promise<unknown> }): PaymentIntentSqlExecutor {
  const toPg = (s: string) => s.replace(/\?(\d+)/gu, (_m, i: string) => `$${i}`);
  return {
    async execute(statement) {
      const st = typeof statement === "string" ? { sql: statement, args: [] as unknown[] } : statement;
      const rows = (await conn.unsafe(toPg(st.sql), st.args ?? [])) as Record<string, unknown>[];
      return { rows };
    },
  };
}

describe.skipIf(!RUN)("bookings payment intent repository (real Postgres)", () => {
  let repoDb: SQL;

  async function seedHold(holdId: string, options: { priceCents?: number; expiresAt?: string } = {}): Promise<void> {
    const hostUserId = `host_${holdId}`;
    const priceCents = options.priceCents ?? 5000;
    const expiresAt = options.expiresAt ?? "2026-06-10T10:10:00Z";
    await repoDb.unsafe(`INSERT INTO bookings.profiles
      (host_user_id, host_timezone, base_price_cents, default_slot_duration_seconds, created_at, updated_at)
      VALUES ($1, 'UTC', $2, 1800, '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')`, [hostUserId, priceCents]);
    await repoDb.unsafe(`INSERT INTO bookings.holds
      (hold_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc, price_cents, status, expires_at_utc, created_at, updated_at)
      VALUES ($1, $2, 'booker_payment', '2026-07-01T10:00:00Z', '2026-07-01T11:00:00Z', $3, 'active', $4, '2026-06-10T10:00:00Z', '2026-06-10T10:00:00Z')`,
    [holdId, hostUserId, priceCents, expiresAt]);
  }

  function inputFor(holdId: string, overrides: Partial<CreatePaymentIntentInput> = {}): CreatePaymentIntentInput {
    return {
      holdId,
      chainId: 8453,
      tokenAddress: "0x0000000000000000000000000000000000000001",
      tokenDecimals: 6,
      tokenSymbol: "USDC",
      recipientAddress: "0x0000000000000000000000000000000000000002",
      amountAtomic: "50000000",
      grossCents: 5000,
      quoteExpiresAt: "2026-06-10T10:10:00Z",
      holdExpiresAt: "2026-06-10T10:10:00Z",
      platformFeeBps: 500,
      platformFeeCents: 250,
      hostPayoutCents: 4750,
      createdAt: "2026-06-10T10:00:00Z",
      ...overrides,
    };
  }

  function writeRepo() {
    return createPaymentIntentWriteRepository(makeExecutor(repoDb));
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

  test("createOrGet is idempotent, replay-validates immutable fields, and preserves uint256 amount strings", async () => {
    await seedHold("hold_pi_create", { priceCents: 5000 });
    const repo = writeRepo();
    const hugeAmount = "115792089237316195423570985008687907853269984665640564039457584007913129639935";

    const created = await repo.createOrGetPaymentIntent(inputFor("hold_pi_create", { amountAtomic: hugeAmount }));
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected create");
    expect(created.intent.paymentIntentId).toBe(paymentIntentIdForHold("hold_pi_create"));
    expect(created.intent.amountAtomic).toBe(hugeAmount);
    expect(created.intent.platformFeeCents).toBe(250);

    const replay = await repo.createOrGetPaymentIntent(inputFor("hold_pi_create", {
      amountAtomic: hugeAmount,
      platformFeeBps: 700,
      platformFeeCents: 350,
      hostPayoutCents: 4650,
    }));
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("expected replay");
    expect(replay.intent.platformFeeCents).toBe(250);

    expect(await repo.createOrGetPaymentIntent(inputFor("hold_pi_create", {
      amountAtomic: "50000001",
      platformFeeCents: 250,
      hostPayoutCents: 4750,
    }))).toEqual({ ok: false, reason: "replay-conflict" });
  });

  test("reserve CAS handles active claims, retryable failures, and expired-claim reclaim", async () => {
    await seedHold("hold_pi_reserve");
    const repo = writeRepo();
    const created = await repo.createOrGetPaymentIntent(inputFor("hold_pi_reserve"));
    if (!created.ok) throw new Error("expected create");
    const paymentIntentId = created.intent.paymentIntentId;
    const txRef = normalizeTxRef(" 0xABCDEF ");

    const first = await repo.reservePaymentIntentForVerification({
      paymentIntentId,
      claimToken: "claim_reserve_1",
      claimExpiresAt: "2026-06-10T10:05:00Z",
      normalizedTxRef: txRef,
      walletAttachmentId: "wallet_reserve",
      nowUtc: "2026-06-10T10:00:00Z",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error("expected reserve");
    expect(first.intent.status).toBe("verifying");
    expect(first.intent.claimedTxRef).toBe("0xabcdef");
    expect(first.intent.version).toBe(2);

    expect(await repo.reservePaymentIntentForVerification({
      paymentIntentId,
      claimToken: "claim_reserve_2",
      claimExpiresAt: "2026-06-10T10:06:00Z",
      normalizedTxRef: txRef,
      walletAttachmentId: "wallet_reserve",
      nowUtc: "2026-06-10T10:01:00Z",
    })).toEqual({ ok: false, reason: "not-reservable" });

    expect(await repo.markPaymentIntentVerificationFailed({
      paymentIntentId,
      claimToken: "wrong_claim",
      nowUtc: "2026-06-10T10:02:00Z",
    })).toBeNull();
    expect((await repo.markPaymentIntentVerificationFailed({
      paymentIntentId,
      claimToken: "claim_reserve_1",
      nowUtc: "2026-06-10T10:02:00Z",
    }))!.status).toBe("verification_failed");

    expect((await repo.reservePaymentIntentForVerification({
      paymentIntentId,
      claimToken: "claim_reserve_3",
      claimExpiresAt: "2026-06-10T10:06:00Z",
      normalizedTxRef: txRef,
      walletAttachmentId: "wallet_reserve",
      nowUtc: "2026-06-10T10:03:00Z",
    })).ok).toBe(true);

    const reclaimed = await repo.reservePaymentIntentForVerification({
      paymentIntentId,
      claimToken: "claim_reserve_4",
      claimExpiresAt: "2026-06-10T10:12:00Z",
      normalizedTxRef: txRef,
      walletAttachmentId: "wallet_reserve",
      nowUtc: "2026-06-10T10:07:00Z",
    });
    expect(reclaimed.ok).toBe(true);
    if (!reclaimed.ok) throw new Error("expected reclaim");
    expect(reclaimed.intent.verificationClaimToken).toBe("claim_reserve_4");
  });

  test("claimed tx uniqueness maps reused transactions to a domain conflict", async () => {
    await seedHold("hold_pi_reuse_a");
    await seedHold("hold_pi_reuse_b");
    const conflictDb = connect(TEST_DB);
    try {
      const repo = createPaymentIntentWriteRepository(makeExecutor(conflictDb));
      const a = await repo.createOrGetPaymentIntent(inputFor("hold_pi_reuse_a"));
      const b = await repo.createOrGetPaymentIntent(inputFor("hold_pi_reuse_b"));
      if (!a.ok || !b.ok) throw new Error("expected creates");

      expect((await repo.reservePaymentIntentForVerification({
        paymentIntentId: a.intent.paymentIntentId,
        claimToken: "claim_reuse_a",
        claimExpiresAt: "2026-06-10T10:05:00Z",
        normalizedTxRef: "0xreused",
        walletAttachmentId: "wallet_reuse_a",
        nowUtc: "2026-06-10T10:00:00Z",
      })).ok).toBe(true);

      expect(await repo.reservePaymentIntentForVerification({
        paymentIntentId: b.intent.paymentIntentId,
        claimToken: "claim_reuse_b",
        claimExpiresAt: "2026-06-10T10:05:00Z",
        normalizedTxRef: "0xreused",
        walletAttachmentId: "wallet_reuse_b",
        nowUtc: "2026-06-10T10:00:00Z",
      })).toEqual({ ok: false, reason: "reused-tx" });
    } finally {
      await conflictDb.end();
    }
  });

  test("verified, rejected, expired, and consumed transitions are claim/status guarded", async () => {
    await seedHold("hold_pi_verified");
    await seedHold("hold_pi_rejected");
    await seedHold("hold_pi_expired", { expiresAt: "2026-06-10T10:01:00Z" });
    const repo = writeRepo();

    const verified = await repo.createOrGetPaymentIntent(inputFor("hold_pi_verified"));
    const rejected = await repo.createOrGetPaymentIntent(inputFor("hold_pi_rejected"));
    const expired = await repo.createOrGetPaymentIntent(inputFor("hold_pi_expired", {
      quoteExpiresAt: "2026-06-10T10:01:00Z",
      holdExpiresAt: "2026-06-10T10:01:00Z",
    }));
    if (!verified.ok || !rejected.ok || !expired.ok) throw new Error("expected creates");

    expect((await repo.reservePaymentIntentForVerification({
      paymentIntentId: verified.intent.paymentIntentId,
      claimToken: "claim_verified",
      claimExpiresAt: "2026-06-10T10:05:00Z",
      normalizedTxRef: "0xverified",
      walletAttachmentId: "wallet_verified",
      nowUtc: "2026-06-10T10:00:00Z",
    })).ok).toBe(true);
    expect(await repo.markPaymentIntentVerified({
      paymentIntentId: verified.intent.paymentIntentId,
      claimToken: "wrong_claim",
      verifiedSenderAddress: "0xsender",
      nowUtc: "2026-06-10T10:01:00Z",
    })).toBeNull();
    const marked = await repo.markPaymentIntentVerified({
      paymentIntentId: verified.intent.paymentIntentId,
      claimToken: "claim_verified",
      verifiedSenderAddress: "0xsender",
      nowUtc: "2026-06-10T10:01:00Z",
    });
    expect(marked!.status).toBe("verified");
    expect(marked!.verifiedSenderAddress).toBe("0xsender");
    expect(await repo.expirePaymentIntentIfDue(verified.intent.paymentIntentId, "2026-06-10T10:20:00Z")).toBeNull();
    expect((await repo.consumePaymentIntent(verified.intent.paymentIntentId, "hold_pi_verified", "2026-06-10T10:02:00Z"))!.status).toBe("consumed");
    expect(await repo.consumePaymentIntent(verified.intent.paymentIntentId, "hold_pi_verified", "2026-06-10T10:03:00Z")).toBeNull();

    expect((await repo.reservePaymentIntentForVerification({
      paymentIntentId: rejected.intent.paymentIntentId,
      claimToken: "claim_rejected",
      claimExpiresAt: "2026-06-10T10:05:00Z",
      normalizedTxRef: "0xrejected",
      walletAttachmentId: "wallet_rejected",
      nowUtc: "2026-06-10T10:00:00Z",
    })).ok).toBe(true);
    expect((await repo.markPaymentIntentRejected({
      paymentIntentId: rejected.intent.paymentIntentId,
      claimToken: "claim_rejected",
      nowUtc: "2026-06-10T10:01:00Z",
    }))!.status).toBe("verification_rejected");
    expect(await repo.consumePaymentIntent(rejected.intent.paymentIntentId, "hold_pi_rejected", "2026-06-10T10:02:00Z")).toBeNull();

    expect((await repo.expirePaymentIntentIfDue(expired.intent.paymentIntentId, "2026-06-10T10:01:00Z"))!.status).toBe("expired");
    expect(await repo.reservePaymentIntentForVerification({
      paymentIntentId: expired.intent.paymentIntentId,
      claimToken: "claim_expired",
      claimExpiresAt: "2026-06-10T10:05:00Z",
      normalizedTxRef: "0xexpired",
      walletAttachmentId: "wallet_expired",
      nowUtc: "2026-06-10T10:01:00Z",
    })).toEqual({ ok: false, reason: "not-reservable" });
  });

  test("transaction-bound create rolls back the payment intent", async () => {
    await seedHold("hold_pi_rollback");
    await expect(repoDb.begin(async (tx: { unsafe(sql: string, args?: unknown[]): Promise<unknown> }) => {
      const repo = createPaymentIntentTxWriteRepository(makeExecutor(tx));
      const created = await repo.createOrGetPaymentIntent(inputFor("hold_pi_rollback"));
      expect(created.ok).toBe(true);
      throw new Error("rollback_probe");
    })).rejects.toThrow("rollback_probe");

    const read = createPaymentIntentRepository(makeExecutor(repoDb));
    expect(await read.getPaymentIntent(paymentIntentIdForHold("hold_pi_rollback"))).toBeNull();
    expect(await read.getPaymentIntentByHold("hold_pi_rollback")).toBeNull();
  });
});
