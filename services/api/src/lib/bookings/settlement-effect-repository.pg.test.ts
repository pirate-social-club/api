// Real-Postgres tests for global booking settlement effects. Runs only when
// BOOKINGS_REPO_TEST_ADMIN_URL is set. Applies canonical core b0001 and validates idempotency,
// retry/resume, coordinator mirroring, and tx-bound rollback against real constraints.
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveCoreRepoPath } from "../../../shared/core-repo-paths";
import {
  createSettlementEffectRepository,
  createSettlementEffectTxWriteRepository,
  createSettlementEffectWriteRepository,
  type SettlementEffectSqlExecutor,
} from "./settlement-effect-repository";

const ADMIN_URL = process.env.BOOKINGS_REPO_TEST_ADMIN_URL;
const RUN = Boolean(ADMIN_URL);
const TEST_DB = "bookings_settlement_effect_repo_test";

function urlFor(db?: string): string {
  const u = new URL(ADMIN_URL as string);
  if (db) u.pathname = `/${db}`;
  if (!u.searchParams.get("sslmode")) u.searchParams.set("sslmode", "disable");
  return u.toString();
}

function connect(db?: string): SQL {
  return new SQL({ url: urlFor(db), tls: false, max: 1, connectionTimeout: 5 } as Record<string, unknown>);
}

function makeExecutor(conn: { unsafe(sql: string, args?: unknown[]): Promise<unknown> }): SettlementEffectSqlExecutor {
  const toPg = (s: string) => s.replace(/\?(\d+)/gu, (_m, i: string) => `$${i}`);
  return {
    async execute(statement) {
      const st = typeof statement === "string" ? { sql: statement, args: [] as unknown[] } : statement;
      const rows = (await conn.unsafe(toPg(st.sql), st.args ?? [])) as Record<string, unknown>[];
      return { rows };
    },
  };
}

describe.skipIf(!RUN)("settlement effect repository (real Postgres)", () => {
  let repoDb: SQL;

  async function seedBooking(bookingId: string): Promise<void> {
    const hostUserId = `host_${bookingId}`;
    await repoDb.unsafe(`INSERT INTO bookings.profiles
      (host_user_id, host_timezone, base_price_cents, default_slot_duration_seconds, payout_wallet_address, created_at, updated_at)
      VALUES ($1, 'UTC', 5000, 1800, '0xpayout', '2026-06-01T00:00:00Z', '2026-06-01T00:00:00Z')`, [hostUserId]);
    await repoDb.unsafe(`INSERT INTO bookings.bookings (
        booking_id, host_user_id, booker_user_id, slot_start_utc, slot_end_utc,
        gross_cents, platform_fee_bps, platform_fee_cents, host_payout_cents, status,
        funding_tx_ref, funding_wallet_address, host_payout_wallet_address,
        source_community_id, confirmed_at, created_at, updated_at
      ) VALUES (
        $1, $2, $3, '2026-07-01T10:00:00Z', '2026-07-01T11:00:00Z',
        5000, 500, 250, 4750, 'completed',
        $4, '0xfunder', '0xpayout',
        'community_settlement_effect', '2026-06-10T10:02:00Z', '2026-06-10T10:02:00Z', '2026-06-10T10:02:00Z'
      )`, [bookingId, hostUserId, `booker_${bookingId}`, `0xfunding_${bookingId}`]);
  }

  function writeRepo() {
    return createSettlementEffectWriteRepository(makeExecutor(repoDb));
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

  test("begins a submitted effect and treats exact idempotent replay as existing-submitted", async () => {
    await seedBooking("bkg_effect_begin");
    const repo = writeRepo();

    const created = await repo.beginSettlementEffectAttempt({
      bookingId: "bkg_effect_begin",
      effectKind: "booking_payout",
      idempotencyKey: "booking_payout:bkg_effect_begin",
      amountCents: 4750,
      recipientAddress: "0xpayout",
      nowUtc: "2026-07-01T11:00:00Z",
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("expected create");
    expect(created.action).toBe("created");
    expect(created.effect.status).toBe("submitted");
    expect(created.effect.attemptCount).toBe(1);

    const replay = await repo.beginSettlementEffectAttempt({
      bookingId: "bkg_effect_begin",
      effectKind: "booking_payout",
      idempotencyKey: "booking_payout:bkg_effect_begin",
      amountCents: 4750,
      recipientAddress: "0xpayout",
      nowUtc: "2026-07-01T11:01:00Z",
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("expected replay");
    expect(replay.action).toBe("existing-submitted");

    expect(await repo.beginSettlementEffectAttempt({
      bookingId: "bkg_effect_begin",
      effectKind: "booking_payout",
      idempotencyKey: "booking_payout:bkg_effect_begin",
      amountCents: 100,
      recipientAddress: "0xpayout",
      nowUtc: "2026-07-01T11:02:00Z",
    })).toEqual({ ok: false, reason: "replay-conflict" });
  });

  test("failed unbroadcast effects retry, while broadcast effects require reconciliation", async () => {
    await seedBooking("bkg_effect_retry");
    const repo = writeRepo();
    await repo.beginSettlementEffectAttempt({
      bookingId: "bkg_effect_retry",
      effectKind: "booking_refund",
      idempotencyKey: "booking_refund:bkg_effect_retry",
      amountCents: 5000,
      recipientAddress: "0xfunder",
      nowUtc: "2026-07-01T11:00:00Z",
    });

    const failed = await repo.failSettlementEffect("booking_refund:bkg_effect_retry", "temporary_signing_error", "2026-07-01T11:01:00Z");
    expect(failed?.status).toBe("failed");
    const retry = await repo.beginSettlementEffectAttempt({
      bookingId: "bkg_effect_retry",
      effectKind: "booking_refund",
      idempotencyKey: "booking_refund:bkg_effect_retry",
      amountCents: 5000,
      recipientAddress: "0xfunder",
      nowUtc: "2026-07-01T11:02:00Z",
    });
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error("expected retry");
    expect(retry.action).toBe("retry");
    expect(retry.effect.attemptCount).toBe(2);

    await repo.mirrorSettlementCoordinatorEffect({
      idempotencyKey: "booking_refund:bkg_effect_retry",
      coordinatorRef: "coord_retry",
      coordinatorState: "broadcast",
      settlementRef: "0xrefund_retry",
      broadcastNonce: 7,
      nowUtc: "2026-07-01T11:03:00Z",
    });
    expect(await repo.failSettlementEffect("booking_refund:bkg_effect_retry", "after_broadcast", "2026-07-01T11:04:00Z")).toBeNull();
  });

  test("mirrors coordinator state, confirms exact transaction refs, and rejects mirror conflicts", async () => {
    await seedBooking("bkg_effect_confirm");
    const repo = writeRepo();
    await repo.beginSettlementEffectAttempt({
      bookingId: "bkg_effect_confirm",
      effectKind: "booking_payout",
      idempotencyKey: "booking_payout:bkg_effect_confirm",
      amountCents: 4750,
      recipientAddress: "0xpayout",
      nowUtc: "2026-07-01T11:00:00Z",
    });

    expect(await repo.mirrorSettlementCoordinatorEffect({
      idempotencyKey: "booking_payout:bkg_effect_confirm",
      coordinatorRef: "coord_confirm",
      coordinatorState: "mystery",
      nowUtc: "2026-07-01T11:00:30Z",
    })).toEqual({ ok: false, reason: "unknown-coordinator-state" });
    const mirrored = await repo.mirrorSettlementCoordinatorEffect({
      idempotencyKey: "booking_payout:bkg_effect_confirm",
      coordinatorRef: "coord_confirm",
      coordinatorState: "broadcast",
      settlementRef: "0xpayout_confirm",
      broadcastNonce: 42,
      nowUtc: "2026-07-01T11:01:00Z",
    });
    expect(mirrored.ok).toBe(true);
    if (!mirrored.ok) throw new Error("expected mirror");
    expect(mirrored.effect.settlementRef).toBe("0xpayout_confirm");

    expect(await repo.confirmSettlementEffect("booking_payout:bkg_effect_confirm", "0xwrong", "2026-07-01T11:02:00Z")).toBeNull();
    const confirmed = await repo.confirmSettlementEffect("booking_payout:bkg_effect_confirm", "0xpayout_confirm", "2026-07-01T11:03:00Z");
    expect(confirmed?.status).toBe("confirmed");
    expect(confirmed?.confirmedAt).toBe("2026-07-01T11:03:00.000Z");

    const replay = await repo.beginSettlementEffectAttempt({
      bookingId: "bkg_effect_confirm",
      effectKind: "booking_payout",
      idempotencyKey: "booking_payout:bkg_effect_confirm",
      amountCents: 4750,
      recipientAddress: "0xpayout",
      nowUtc: "2026-07-01T11:04:00Z",
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("expected confirmed replay");
    expect(replay.action).toBe("existing-confirmed");

    expect(await repo.mirrorSettlementCoordinatorEffect({
      idempotencyKey: "booking_payout:bkg_effect_confirm",
      coordinatorRef: "different_coord",
      coordinatorState: "confirmed",
      settlementRef: "0xpayout_confirm",
      broadcastNonce: 42,
      nowUtc: "2026-07-01T11:05:00Z",
    })).toEqual({ ok: false, reason: "mirror-conflict" });
  });

  test("enforces one effect per booking/kind and lists submitted effects deterministically", async () => {
    await seedBooking("bkg_effect_unique");
    await seedBooking("bkg_effect_list");
    const repo = writeRepo();

    expect((await repo.beginSettlementEffectAttempt({
      bookingId: "bkg_effect_unique",
      effectKind: "booking_payout",
      idempotencyKey: "booking_payout:bkg_effect_unique:first",
      amountCents: 4750,
      recipientAddress: "0xpayout",
      nowUtc: "2026-07-01T11:00:00Z",
    })).ok).toBe(true);
    const conflictDb = connect(TEST_DB);
    try {
      expect(await createSettlementEffectWriteRepository(makeExecutor(conflictDb)).beginSettlementEffectAttempt({
        bookingId: "bkg_effect_unique",
        effectKind: "booking_payout",
        idempotencyKey: "booking_payout:bkg_effect_unique:second",
        amountCents: 4750,
        recipientAddress: "0xpayout",
        nowUtc: "2026-07-01T11:01:00Z",
      })).toEqual({ ok: false, reason: "effect-conflict" });
    } finally {
      await conflictDb.end();
    }
    expect((await repo.beginSettlementEffectAttempt({
      bookingId: "bkg_effect_list",
      effectKind: "booking_refund",
      idempotencyKey: "booking_refund:bkg_effect_list",
      amountCents: 5000,
      recipientAddress: "0xfunder",
      nowUtc: "2026-07-01T10:59:00Z",
    })).ok).toBe(true);

    expect((await repo.listSettlementEffectsByBooking("bkg_effect_unique")).map((e) => e.idempotencyKey)).toEqual([
      "booking_payout:bkg_effect_unique:first",
    ]);
    expect((await repo.listSubmittedSettlementEffects(2)).map((e) => e.idempotencyKey)).toEqual([
      "booking_refund:bkg_effect_list",
      "booking_payout:bkg_effect_unique:first",
    ]);
  });

  test("transaction-bound settlement effects roll back", async () => {
    await seedBooking("bkg_effect_rollback");
    await expect(repoDb.begin(async (tx: { unsafe(sql: string, args?: unknown[]): Promise<unknown> }) => {
      const repo = createSettlementEffectTxWriteRepository(makeExecutor(tx));
      const created = await repo.beginSettlementEffectAttempt({
        bookingId: "bkg_effect_rollback",
        effectKind: "booking_payout",
        idempotencyKey: "booking_payout:bkg_effect_rollback",
        amountCents: 4750,
        recipientAddress: "0xpayout",
        nowUtc: "2026-07-01T11:00:00Z",
      });
      expect(created.ok).toBe(true);
      throw new Error("rollback_probe");
    })).rejects.toThrow("rollback_probe");

    const read = createSettlementEffectRepository(makeExecutor(repoDb));
    expect(await read.getSettlementEffectByIdempotencyKey("booking_payout:bkg_effect_rollback")).toBeNull();
  });
});
