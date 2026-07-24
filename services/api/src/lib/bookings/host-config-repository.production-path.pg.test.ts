// Production request-scoped path test for the host-config repository. Unlike the lightweight
// .pg.test.ts (which uses a bun executor shim and imports no runtime-deps), this exercises the REAL
// production path: withRequestControlPlaneClients -> getControlPlaneClient(env) ->
// PostgresClientAdapter / PostgresTransactionAdapter -> repository, with only the pg connection substituted
// via setControlPlanePostgresPoolFactoryForTests. It therefore imports runtime-deps (which pulls
// pg) and must run in the full services/api install job, with a PostgreSQL service.
//
// Runs only when BOOKINGS_REPO_TEST_ADMIN_URL is set. Isolated DB, full teardown, no credentials printed.
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import type { Env } from "../../env";
import {
  getControlPlaneClient, setControlPlanePostgresPoolFactoryForTests, withRequestControlPlaneClients,
} from "../runtime-deps";
import { applyCanonicalBookingMigrations } from "./test-migrations";
import { createBookingHostConfigRepository, createBookingHostConfigTxRepository } from "./host-config-repository";
import {
  createAvailabilityException,
  createAvailabilityRule,
  createPriceRule,
  getBookingProfile,
  listAvailabilityExceptions,
  listAvailabilityRules,
  listPriceRules,
  setProfilePublished,
  upsertBookingProfile,
} from "./host-authoring-service";

const ADMIN_URL = process.env.BOOKINGS_REPO_TEST_ADMIN_URL;
if (process.env.BOOKINGS_PG_CI_REQUIRED === "true" && !ADMIN_URL) {
  throw new Error("BOOKINGS_REPO_TEST_ADMIN_URL is required for bookings host-config production-path PostgreSQL CI");
}
const RUN = Boolean(ADMIN_URL);
const TEST_DB = "bookings_prodpath_test";
// The URL value only keys the request-scoped cache; the injected factory ignores it and uses repoDb.
const PG_ENV = { CONTROL_PLANE_DATABASE_URL: `postgres://prodpath@localhost:5432/${TEST_DB}` } as unknown as Env;

function urlFor(db?: string): string {
  const u = new URL(ADMIN_URL as string);
  if (db) u.pathname = `/${db}`;
  if (!u.searchParams.get("sslmode")) u.searchParams.set("sslmode", "disable");
  return u.toString();
}
function connect(db?: string): SQL {
  return new SQL({ url: urlFor(db), tls: false, max: 1, connectionTimeout: 5 } as Record<string, unknown>);
}

describe.skipIf(!RUN)("bookings host-config repository (production request-scoped path)", () => {
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
    await applyCanonicalBookingMigrations(db);
    await db.unsafe(`INSERT INTO bookings.profiles
      (host_user_id, host_timezone, base_price_cents, default_slot_duration_seconds, platform_fee_bps, is_published, created_at, updated_at)
      VALUES ('host1','America/New_York',5000,1800,1000,true,'2026-06-01T00:00:00Z','2026-06-02T00:00:00Z')`);
    await db.unsafe(`INSERT INTO bookings.availability_rules
      (rule_id, host_user_id, by_weekday, start_local, end_local, slot_duration_seconds, created_at, updated_at)
      VALUES
      ('r_b','host1','{1,3,5}','09:00','17:00',1800,'2026-06-01T00:00:00Z','2026-06-01T00:00:00Z'),
      ('r_a','host1','{2,4}','10:00','12:00',1800,'2026-06-01T00:00:00Z','2026-06-01T00:00:00Z'),
      ('r_c','host1','{6}','08:00','09:00',3600,'2026-06-05T00:00:00Z','2026-06-05T00:00:00Z')`);
    await db.unsafe(`INSERT INTO bookings.price_rules
      (price_rule_id, host_user_id, price_cents, priority, created_at, updated_at)
      VALUES
      ('p_lo','host1',4000,10,'2026-06-01T00:00:00Z','2026-06-01T00:00:00Z'),
      ('p_hi_b','host1',9000,20,'2026-06-01T00:00:00Z','2026-06-01T00:00:00Z'),
      ('p_hi_a','host1',7000,20,'2026-06-01T00:00:00Z','2026-06-01T00:00:00Z')`);
    await db.end();

    repoDb = connect(TEST_DB);
  });

  afterAll(async () => {
    setControlPlanePostgresPoolFactoryForTests(null);
    if (repoDb) await repoDb.end();
    const root = connect();
    await root.unsafe(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => {});
    for (const r of ["control_plane_api_rw", "control_plane_api_ro"]) {
      await root.unsafe(`DROP ROLE IF EXISTS ${r}`).catch(() => {});
    }
    await root.end();
    const sentinelPath = process.env.BOOKINGS_PG_SENTINEL_PATH;
    if (sentinelPath) {
      await writeFile(sentinelPath, "host-config-repository-production-path-postgres-suite-complete\n", "utf8");
    }
  });

  test("getControlPlaneClient(postgresEnv) throws outside withRequestControlPlaneClients", () => {
    setControlPlanePostgresPoolFactoryForTests(null);
    expect(() => getControlPlaneClient(PG_ENV)).toThrow(/request-scoped/);
  });

  test("inside the request scope: real adapters read canonical data, tx works, pool once + closed", async () => {
    let created = 0;
    let ended = 0;
    setControlPlanePostgresPoolFactoryForTests((_url) => {
      created += 1;
      const run = async (sql: string, values?: unknown[]) => ({
        rows: (await repoDb.unsafe(sql, values ?? [])) as Record<string, unknown>[],
        rowCount: null,
      });
      return { query: run, connect: async () => ({ query: run, release: () => {} }), end: async () => { ended += 1; } };
    });
    try {
      await withRequestControlPlaneClients(async () => {
        const client = getControlPlaneClient(PG_ENV); // real request-scoped PostgresClientAdapter
        getControlPlaneClient(PG_ENV); // same URL -> cached, factory not invoked again
        const repo = createBookingHostConfigRepository(client);
        const cfg = await repo.getHostConfiguration("host1");
        expect(cfg).not.toBeNull();
        expect(cfg!.priceRules.map((p) => p.priceRuleId)).toEqual(["p_hi_a", "p_hi_b", "p_lo"]);
        // client.transaction() -> PostgresTransactionAdapter (connect + BEGIN/COMMIT), repository reads through it
        const tx = await client.transaction("read");
        try {
          const txRepo = createBookingHostConfigTxRepository(tx);
          expect((await txRepo.listAvailabilityRules("host1")).map((r) => r.ruleId)).toEqual(["r_a", "r_b", "r_c"]);
          await tx.commit();
        } finally {
          tx.close();
        }
      });
    } finally {
      setControlPlanePostgresPoolFactoryForTests(null);
    }
    expect(created).toBe(1); // pool created once per request URL
    expect(ended).toBe(1); // closed when the request scope exits
  });

  test("host authoring service writes through the production request-scoped global path", async () => {
    let ended = 0;
    setControlPlanePostgresPoolFactoryForTests((_url) => {
      const run = async (sql: string, values?: unknown[]) => ({
        rows: (await repoDb.unsafe(sql, values ?? [])) as Record<string, unknown>[],
        rowCount: null,
      });
      return { query: run, connect: async () => ({ query: run, release: () => {} }), end: async () => { ended += 1; } };
    });
    try {
      await withRequestControlPlaneClients(async () => {
        const hostUserId = "host_authoring_prodpath";
        const profileResult = await upsertBookingProfile(PG_ENV, hostUserId, {
          host_timezone: "Europe/Vienna",
          base_price_cents: 5000,
          default_slot_duration_seconds: 1800,
          topics: ["mentoring", "music"],
          payout_wallet_address: "0x1111111111111111111111111111111111111111",
        });
        expect(profileResult.ok).toBe(true);
        expect(profileResult.ok && profileResult.data.created).toBe(true);

        const publishResult = await setProfilePublished(PG_ENV, hostUserId, true);
        expect(publishResult.ok).toBe(true);
        expect(publishResult.ok && publishResult.data.isPublished).toBe(true);

        const ruleResult = await createAvailabilityRule(PG_ENV, hostUserId, {
          by_weekday: [1, 2],
          start_local: "09:00",
          end_local: "12:00",
          slot_duration_seconds: 1800,
        });
        expect(ruleResult.ok).toBe(true);

        const exceptionResult = await createAvailabilityException(PG_ENV, hostUserId, {
          kind: "block",
          start_utc: "2026-07-01T00:00:00Z",
          end_utc: "2026-07-02T00:00:00Z",
        });
        expect(exceptionResult.ok).toBe(true);

        const priceResult = await createPriceRule(PG_ENV, hostUserId, {
          price_cents: 6500,
          match_weekday: [1],
        }, 5);
        expect(priceResult.ok).toBe(true);

        expect((await getBookingProfile(PG_ENV, hostUserId))!.topics).toEqual(["mentoring", "music"]);
        expect((await listAvailabilityRules(PG_ENV, hostUserId)).map((rule) => rule.ruleId)).toHaveLength(1);
        expect((await listAvailabilityExceptions(PG_ENV, hostUserId)).map((exception) => exception.kind)).toEqual(["block"]);
        expect((await listPriceRules(PG_ENV, hostUserId)).map((price) => price.priceCents)).toEqual([6500]);
      });
    } finally {
      setControlPlanePostgresPoolFactoryForTests(null);
    }
    expect(ended).toBe(1);
  });
});
