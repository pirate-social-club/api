// Real-Postgres test for the host-configuration read repository. Runs ONLY when
// BOOKINGS_REPO_TEST_ADMIN_URL is set (API CI provisions PostgreSQL 17). Applies the CANONICAL core
// b0001 migration (located via resolveCoreRepoPath — never copies DDL), seeds rows, and exercises the
// repository through an executor that mirrors PostgresClientAdapter (?N -> $N, {rows}). Isolated DB with
// full teardown; no credentials printed.
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolveCoreRepoPath } from "../../../shared/core-repo-paths";
import {
  createBookingHostConfigRepository, createBookingHostConfigTxRepository, type BookingSqlExecutor,
} from "./host-config-repository";

const ADMIN_URL = process.env.BOOKINGS_REPO_TEST_ADMIN_URL;
const RUN = Boolean(ADMIN_URL);
const TEST_DB = "bookings_repo_test";

function urlFor(db?: string): string {
  const u = new URL(ADMIN_URL as string);
  if (db) u.pathname = `/${db}`;
  if (!u.searchParams.get("sslmode")) u.searchParams.set("sslmode", "disable");
  return u.toString();
}
function connect(db?: string): SQL {
  return new SQL({ url: urlFor(db), tls: false, max: 1, connectionTimeout: 5 } as Record<string, unknown>);
}

// Executor mirroring PostgresClientAdapter's placeholder translation; wraps a bun SQL connection or tx.
function makeExecutor(conn: { unsafe(sql: string, args?: unknown[]): Promise<unknown> }): BookingSqlExecutor {
  const toPg = (s: string) => s.replace(/\?(\d+)/gu, (_m, i: string) => `$${i}`);
  return {
    async execute(statement) {
      const st = typeof statement === "string" ? { sql: statement, args: [] as unknown[] } : statement;
      const rows = (await conn.unsafe(toPg(st.sql), st.args ?? [])) as Record<string, unknown>[];
      return { rows };
    },
  };
}

describe.skipIf(!RUN)("bookings host-config repository (real Postgres)", () => {
  let repoDb: SQL;

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
    // Apply the CANONICAL core migration (simple-protocol multi-statement); do not copy its DDL.
    const b0001 = readFileSync(resolveCoreRepoPath("db/bookings/migrations/b0001_bookings_global_schema.sql"), "utf8");
    await db.unsafe(b0001);

    // host1: fully populated; host2: nullable fields null + topics null.
    await db.unsafe(`INSERT INTO bookings.profiles
      (host_user_id, display_headline, bio, topics, intro_video_ref, host_timezone, base_price_cents,
       default_slot_duration_seconds, platform_fee_bps, payout_wallet_address, is_published, created_at, updated_at)
      VALUES
      ('host1','1:1 review','bio text','["chess","go"]'::jsonb,'asset_1','America/New_York',5000,1800,1000,'0xabc',true,
        '2026-06-01T00:00:00Z','2026-06-02T00:00:00Z'),
      ('host2',NULL,NULL,NULL,NULL,'UTC',3000,900,500,NULL,false,'2026-06-01T00:00:00Z','2026-06-01T00:00:00Z')`);

    // Availability rules: r_b shares created_at with r_a (id tiebreak), r_c is later.
    await db.unsafe(`INSERT INTO bookings.availability_rules
      (rule_id, host_user_id, by_weekday, start_local, end_local, slot_duration_seconds, effective_from_utc, effective_until_utc, created_at, updated_at)
      VALUES
      ('r_b','host1','{1,3,5}','09:00','17:00',1800,NULL,NULL,'2026-06-01T00:00:00Z','2026-06-01T00:00:00Z'),
      ('r_a','host1','{2,4}','10:00','12:00',1800,'2026-07-01T00:00:00Z','2026-08-01T00:00:00Z','2026-06-01T00:00:00Z','2026-06-01T00:00:00Z'),
      ('r_c','host1','{6}','08:00','09:00',3600,NULL,NULL,'2026-06-05T00:00:00Z','2026-06-05T00:00:00Z')`);

    await db.unsafe(`INSERT INTO bookings.availability_exceptions
      (exception_id, host_user_id, kind, start_utc, end_utc, created_at)
      VALUES
      ('e_late','host1','block','2026-07-10T00:00:00Z','2026-07-11T00:00:00Z','2026-06-01T00:00:00Z'),
      ('e_early','host1','open','2026-07-02T00:00:00Z','2026-07-03T00:00:00Z','2026-06-01T00:00:00Z')`);

    // Price rules: priority 20 has two rows (id tiebreak), priority 10 sorts after.
    await db.unsafe(`INSERT INTO bookings.price_rules
      (price_rule_id, host_user_id, match_weekday, match_local_start, match_local_end, match_duration_seconds, price_cents, priority, created_at, updated_at)
      VALUES
      ('p_lo','host1',NULL,NULL,NULL,NULL,4000,10,'2026-06-01T00:00:00Z','2026-06-01T00:00:00Z'),
      ('p_hi_b','host1','{5,6}','18:00','22:00',NULL,9000,20,'2026-06-01T00:00:00Z','2026-06-01T00:00:00Z'),
      ('p_hi_a','host1','{1}','06:00','08:00',1800,7000,20,'2026-06-01T00:00:00Z','2026-06-01T00:00:00Z')`);
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

  test("missing profile returns null (profile and aggregate)", async () => {
    const repo = createBookingHostConfigRepository(makeExecutor(repoDb));
    expect(await repo.getProfile("nobody")).toBeNull();
    expect(await repo.getHostConfiguration("nobody")).toBeNull();
  });

  test("profile decodes nullable fields, JSONB topics, money, and timestamps", async () => {
    const repo = createBookingHostConfigRepository(makeExecutor(repoDb));
    const h1 = await repo.getProfile("host1");
    expect(h1).not.toBeNull();
    expect(h1!.topics).toEqual(["chess", "go"]);
    expect(h1!.basePriceCents).toBe(5000);
    expect(h1!.platformFeeBps).toBe(1000);
    expect(h1!.isPublished).toBe(true);
    expect(h1!.payoutWalletAddress).toBe("0xabc");
    expect(h1!.createdAt).toBe("2026-06-01T00:00:00.000Z");
    const h2 = await repo.getProfile("host2");
    expect(h2!.topics).toBeNull();
    expect(h2!.displayHeadline).toBeNull();
    expect(h2!.payoutWalletAddress).toBeNull();
    expect(h2!.isPublished).toBe(false);
  });

  test("availability rules: TIME, weekday arrays, nullable effective, ordering by created_at then id", async () => {
    const repo = createBookingHostConfigRepository(makeExecutor(repoDb));
    const rules = await repo.listAvailabilityRules("host1");
    expect(rules.map((r) => r.ruleId)).toEqual(["r_a", "r_b", "r_c"]); // same ts: id tiebreak; then later ts
    expect(rules[0].byWeekday).toEqual([2, 4]);
    expect(rules[0].startLocal).toBe("10:00:00");
    expect(rules[0].effectiveFromUtc).toBe("2026-07-01T00:00:00.000Z");
    expect(rules[1].effectiveFromUtc).toBeNull();
  });

  test("exceptions ordered by start_utc; kind decoded", async () => {
    const repo = createBookingHostConfigRepository(makeExecutor(repoDb));
    const ex = await repo.listAvailabilityExceptions("host1");
    expect(ex.map((e) => e.exceptionId)).toEqual(["e_early", "e_late"]);
    expect(ex[0].kind).toBe("open");
    expect(ex[0].startUtc).toBe("2026-07-02T00:00:00.000Z");
  });

  test("price rules ordered priority DESC then id ASC; nullable match fields", async () => {
    const repo = createBookingHostConfigRepository(makeExecutor(repoDb));
    const prices = await repo.listPriceRules("host1");
    expect(prices.map((p) => p.priceRuleId)).toEqual(["p_hi_a", "p_hi_b", "p_lo"]);
    expect(prices[2].matchWeekday).toBeNull();
    expect(prices[2].matchLocalStart).toBeNull();
    expect(prices[0].matchWeekday).toEqual([1]);
    expect(prices[0].matchLocalStart).toBe("06:00:00");
  });

  test("getHostConfiguration aggregates profile + lists", async () => {
    const repo = createBookingHostConfigRepository(makeExecutor(repoDb));
    const cfg = await repo.getHostConfiguration("host1");
    expect(cfg!.profile.hostUserId).toBe("host1");
    expect(cfg!.availabilityRules.length).toBe(3);
    expect(cfg!.availabilityExceptions.length).toBe(2);
    expect(cfg!.priceRules.length).toBe(3);
  });

  test("reads are schema-qualified (work with bookings off the search_path)", async () => {
    const probe = connect(TEST_DB);
    await probe.unsafe(`SET search_path = pg_catalog`); // unqualified table refs would now fail
    const repo = createBookingHostConfigRepository(makeExecutor(probe));
    expect((await repo.getProfile("host1"))!.hostUserId).toBe("host1");
    await probe.end();
  });

  test("getHostConfiguration is a single snapshot-consistent statement", async () => {
    // A lone SELECT sees one MVCC snapshot under READ COMMITTED, so the aggregate is internally
    // consistent without any caller-owned isolation level.
    const repo = createBookingHostConfigRepository(makeExecutor(repoDb));
    const cfg = await repo.getHostConfiguration("host1");
    expect(cfg!.availabilityRules.map((r) => r.ruleId)).toEqual(["r_a", "r_b", "r_c"]);
    expect(cfg!.availabilityExceptions.map((e) => e.exceptionId)).toEqual(["e_early", "e_late"]);
    expect(cfg!.priceRules.map((p) => p.priceRuleId)).toEqual(["p_hi_a", "p_hi_b", "p_lo"]);
  });

  test("transaction-bound repository reads within a caller-owned tx (binding, not isolation)", async () => {
    // Demonstrates the tx-bound factory uses the caller's transaction; it does NOT assert cross-statement
    // consistency for the per-table list methods (that is the caller's isolation level to choose).
    await repoDb.begin(async (tx: { unsafe(sql: string, args?: unknown[]): Promise<unknown> }) => {
      const repo = createBookingHostConfigTxRepository(makeExecutor(tx));
      expect((await repo.getProfile("host1"))!.hostUserId).toBe("host1");
      expect((await repo.listPriceRules("host1")).map((p) => p.priceRuleId)).toEqual(["p_hi_a", "p_hi_b", "p_lo"]);
    });
  });
});
