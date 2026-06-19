import { beforeEach, describe, expect, test } from "bun:test"
import {
  assertCommunityBinding,
  QUARANTINE_WINDOW_MS,
  POOL_CACHE_TTL_MS,
  POOL_CACHE_SHORT_TTL_MS,
  resetPoolCacheForTests,
  resolveD1,
  runShardBatch,
  runShardRead,
  runShardWrite,
  ShardReadError,
  type ShardEnv,
} from "./shard-read"

type FakeCall = { sql: string; args: unknown[] }

function fakeD1(rows: Record<string, unknown>[] = [{ x: 1 }]) {
  const calls: FakeCall[] = []
  function stmt(sql: string) {
    const s: any = {
      _args: [] as unknown[],
      bind(...a: unknown[]) {
        s._args = a
        return s
      },
      all() {
        calls.push({ sql, args: s._args })
        return Promise.resolve({ results: rows, success: true, meta: { changes: 0, last_row_id: 0 } })
      },
    }
    return s
  }
  return {
    calls,
    prepare(sql: string) {
      return stmt(sql)
    },
    batch(stmts: any[]) {
      return Promise.all(stmts.map((st) => st.all()))
    },
  }
}

type FakePoolRow = {
  binding_name: string
  community_id: string | null
  allocated_at: string | null
  last_error: string | null
  released_at: string | null
  version: number
}

/**
 * Minimal in-memory fake of the d1_pool D1. Supports the four queries
 * assertCommunityBinding + ensurePoolSeeded actually issue:
 *   - SELECT COUNT(*) AS n FROM d1_pool
 *   - SELECT binding_name, last_error FROM d1_pool WHERE community_id = ?1
 *   - INSERT OR IGNORE INTO d1_pool (...) VALUES (...)
 *
 * Anything else returns an empty result. The fake is intentionally narrow
 * — the production code's query set is small and stable.
 */
function fakePoolD1(initialRows: FakePoolRow[] = []) {
  const calls: FakeCall[] = []
  const rows: FakePoolRow[] = [...initialRows]
  function stmt(sql: string) {
    const s: any = {
      _sql: sql,
      _args: [] as unknown[],
      bind(...a: unknown[]) {
        s._args = a
        return s
      },
      async all() {
        calls.push({ sql, args: s._args })
        return { results: [], success: true, meta: { changes: 0, last_row_id: 0 } }
      },
      async first() {
        calls.push({ sql, args: s._args })
        if (/SELECT COUNT\(\*\) AS n FROM d1_pool/.test(sql)) {
          return { n: rows.length }
        }
        if (/SELECT binding_name, last_error FROM d1_pool WHERE community_id = \?1/.test(sql)) {
          const communityId = s._args[0] as string
          return rows.find((r) => r.community_id === communityId) ?? null
        }
        return null
      },
      async run() {
        calls.push({ sql, args: s._args })
        if (/INSERT OR IGNORE INTO d1_pool/.test(sql)) {
          const [binding_name, community_id, allocated_at] = s._args as [string, string, string]
          const existing = rows.find((r) => r.binding_name === binding_name)
          if (existing) {
            return { success: true, meta: { changes: 0, last_row_id: 0 } }
          }
          rows.push({
            binding_name,
            community_id,
            allocated_at,
            last_error: null,
            released_at: null,
            version: 0,
          })
          return { success: true, meta: { changes: 1, last_row_id: rows.length } }
        }
        return { success: true, meta: { changes: 0, last_row_id: 0 } }
      },
    }
    return s
  }
  return {
    calls,
    rows,
    prepare(sql: string) {
      return stmt(sql)
    },
  }
}

type FakePoolD1 = ReturnType<typeof fakePoolD1>

/**
 * Default env: empty pool (the seed will populate it on first call), env JSON
 * with cmt_1 → DB_CMTY_PILOT, and the community DB bound. Tests that need a
 * different pool or env JSON pass `options`.
 */
function envWith(db: unknown, options?: { pool?: FakePoolD1; envJson?: string | undefined }): ShardEnv {
  const pool = options?.pool ?? fakePoolD1()
  const env: Record<string, unknown> = {
    DB_CMTY_PILOT: db as D1Database,
    DB_CMTY_FIXTURE: db as D1Database,
    D1_POOL: pool as unknown as D1Database,
  }
  if (options?.envJson !== undefined) {
    env["COMMUNITY_D1_BINDING_MAP_JSON"] = options.envJson
  } else {
    env["COMMUNITY_D1_BINDING_MAP_JSON"] = JSON.stringify({ cmt_1: "DB_CMTY_PILOT" })
  }
  return env as unknown as ShardEnv
}

beforeEach(() => {
  resetPoolCacheForTests()
})

describe("quarantine window >= cache TTL invariant", () => {
  test("QUARANTINE_WINDOW_MS strictly exceeds POOL_CACHE_TTL_MS (D1-NATIVE-PROVISIONING-DESIGN.md §5)", () => {
    // The whole point of the cache is an optimization, but correctness depends
    // on the quarantine window being larger than every cache TTL. A stale cache
    // entry combined with a release+reallocate is a cross-tenant read. If this
    // test ever fails, the cross-tenant hole is open — fix the relationship
    // before touching the rest of the code.
    expect(QUARANTINE_WINDOW_MS).toBeGreaterThan(POOL_CACHE_TTL_MS)
    expect(QUARANTINE_WINDOW_MS).toBeGreaterThan(POOL_CACHE_SHORT_TTL_MS)
  })
})

describe("resolveD1 binding allowlist", () => {
  test("resolves a real bound D1 namespace", () => {
    const db = fakeD1()
    expect(resolveD1(envWith(db), "DB_CMTY_PILOT")).toBe(db as unknown as D1Database)
  })

  test("rejects an unknown binding name (control-plane row not trusted)", () => {
    try {
      resolveD1(envWith(fakeD1()), "DB_NOT_BOUND")
      throw new Error("should have thrown")
    } catch (e) {
      expect(e).toBeInstanceOf(ShardReadError)
      expect((e as ShardReadError).code).toBe("shard_unknown_binding")
    }
  })

  test("rejects a non-D1 binding (e.g. a service/KV with no prepare)", () => {
    const notD1 = { fetch: () => {} } as unknown as D1Database
    try {
      resolveD1({ DB_CMTY_PILOT: notD1 } as ShardEnv, "DB_CMTY_PILOT")
      throw new Error("should have thrown")
    } catch (e) {
      expect((e as ShardReadError).code).toBe("shard_unknown_binding")
    }
  })
})

describe("runShardRead", () => {
  test("runs a SELECT and maps rows + binds args", async () => {
    const db = fakeD1([{ id: "c1" }])
    const result = await runShardRead(envWith(db), {
      communityId: "cmt_1",
      bindingName: "DB_CMTY_PILOT",
      statement: { sql: "SELECT id FROM t WHERE id = ?1", args: ["c1"] },
    })
    expect(result.rows).toEqual([{ id: "c1" }])
    expect(db.calls[0]).toEqual({ sql: "SELECT id FROM t WHERE id = ?1", args: ["c1"] })
  })

  test("rejects a write statement and never touches D1", async () => {
    const db = fakeD1()
    await expect(
      runShardRead(envWith(db), {
        communityId: "cmt_1",
        bindingName: "DB_CMTY_PILOT",
        statement: "INSERT INTO t (id) VALUES (?1)",
      }),
    ).rejects.toMatchObject({ code: "shard_read_only_violation" })
    expect(db.calls).toHaveLength(0)
  })

  test("rejects statement-batch smuggling", async () => {
    await expect(
      runShardRead(envWith(fakeD1()), {
        communityId: "cmt_1",
        bindingName: "DB_CMTY_PILOT",
        statement: "SELECT 1; DROP TABLE t",
      }),
    ).rejects.toMatchObject({ code: "shard_read_only_violation" })
  })
})

describe("runShardBatch", () => {
  test("runs read batch and maps each result", async () => {
    const db = fakeD1([{ n: 1 }])
    const results = await runShardBatch(envWith(db), {
      communityId: "cmt_1",
      bindingName: "DB_CMTY_PILOT",
      statements: [
        { sql: "SELECT 1 AS n", args: [] },
        { sql: "SELECT n FROM t", args: [] },
      ],
    })
    expect(results).toHaveLength(2)
    expect(results[0].rows).toEqual([{ n: 1 }])
  })

  test("rejects a batch containing any write", async () => {
    const db = fakeD1()
    await expect(
      runShardBatch(envWith(db), {
        communityId: "cmt_1",
        bindingName: "DB_CMTY_PILOT",
        statements: [
          { sql: "SELECT 1", args: [] },
          { sql: "UPDATE t SET n = 1", args: [] },
        ],
      }),
    ).rejects.toMatchObject({ code: "shard_read_only_violation" })
    expect(db.calls).toHaveLength(0)
  })
})

describe("assertCommunityBinding (community↔binding allowlist via d1_pool)", () => {
  test("allows the mapped (community, binding) pair; cold-start seed populates an empty pool", async () => {
    // Default env: empty pool, env JSON has cmt_1 → DB_CMTY_PILOT. The first
    // call triggers the seed (INSERT OR IGNORE) and then resolves.
    const pool = fakePoolD1()
    const db = fakeD1()
    await assertCommunityBinding(envWith(db, { pool }), "cmt_1", "DB_CMTY_PILOT")
    expect(pool.rows).toHaveLength(1)
    expect(pool.rows[0]).toMatchObject({
      binding_name: "DB_CMTY_PILOT",
      community_id: "cmt_1",
    })
  })

  test("rejects a valid binding requested by an UNMAPPED community (cross-tenant guard)", async () => {
    const db = fakeD1()
    await expect(
      assertCommunityBinding(envWith(db), "cmt_other", "DB_CMTY_PILOT"),
    ).rejects.toMatchObject({ code: "shard_binding_not_allowed" })
  })

  test("rejects a community pointed at a DIFFERENT binding than its mapping", async () => {
    const db = fakeD1()
    await expect(
      assertCommunityBinding(envWith(db), "cmt_1", "DB_OTHER"),
    ).rejects.toMatchObject({ code: "shard_binding_not_allowed" })
  })

  test("fails when the pool has no row for the community (env JSON cannot rescue an unknown community)", async () => {
    // The pool is pre-populated with cmt_1 → DB_CMTY_PILOT, so cmt_other is
    // unknown to the pool — regardless of the env JSON. The pool is the
    // runtime source of truth; the env JSON is only a cold-start seed.
    const pool = fakePoolD1([
      { binding_name: "DB_CMTY_PILOT", community_id: "cmt_1", allocated_at: "t0", last_error: null, released_at: null, version: 0 },
    ])
    const envJson = JSON.stringify({ cmt_other: "DB_CMTY_PILOT" })
    await expect(
      assertCommunityBinding(envWith(fakeD1(), { pool, envJson }), "cmt_other", "DB_CMTY_PILOT"),
    ).rejects.toMatchObject({ code: "shard_binding_not_allowed" })
  })

  test("fails when D1_POOL binding is absent on the env", async () => {
    // The D1_POOL binding is required — no fallback to the env JSON. This is
    // the post-de-staticization invariant: the env JSON is only a seed, never
    // a runtime auth source.
    const env = {
      DB_CMTY_PILOT: fakeD1() as unknown as D1Database,
      COMMUNITY_D1_BINDING_MAP_JSON: JSON.stringify({ cmt_1: "DB_CMTY_PILOT" }),
    } as ShardEnv
    await expect(
      assertCommunityBinding(env, "cmt_1", "DB_CMTY_PILOT"),
    ).rejects.toMatchObject({ code: "shard_unknown_binding" })
  })

  test("cold-start seed is a no-op when the pool is already populated", async () => {
    // Pre-populated pool with cmt_1 → DB_CMTY_FIXTURE (different from the env
    // JSON's cmt_1 → DB_CMTY_PILOT). The seed sees the pool is non-empty and
    // does not overwrite the existing row — the pool is the source of truth
    // once populated.
    const pool = fakePoolD1([
      { binding_name: "DB_CMTY_FIXTURE", community_id: "cmt_1", allocated_at: "t0", last_error: null, released_at: null, version: 0 },
    ])
    const db = fakeD1()
    // The pool's existing row says cmt_1 → DB_CMTY_FIXTURE, so requesting
    // DB_CMTY_PILOT for cmt_1 must be rejected even though the env JSON says
    // cmt_1 → DB_CMTY_PILOT.
    await expect(
      assertCommunityBinding(envWith(db, { pool }), "cmt_1", "DB_CMTY_PILOT"),
    ).rejects.toMatchObject({ code: "shard_binding_not_allowed" })
    expect(pool.rows).toHaveLength(1)
    expect(pool.rows[0].binding_name).toBe("DB_CMTY_FIXTURE")
  })

  test("§8.2 — poisoned control-plane routing row is still rejected by the shard (the keystone property)", async () => {
    // The keystone of the D1-native workstream. Pool table has:
    //   A → A's binding
    //   B → B's binding
    // A poisoned control-plane row says community A → B's binding. The shard
    // must reject, because the pool — its own second gate — says A → A.
    //
    // This is the entire justification for the keystone: the two-gate
    // authorization property survives de-staticization. If this test fails,
    // the design is wrong, not the test (per SHARD-D1-NATIVE-WORKSTREAM.md
    // step 1 merge gate).
    const pool = fakePoolD1([
      { binding_name: "DB_CMTY_PILOT", community_id: "cmt_A", allocated_at: "t0", last_error: null, released_at: null, version: 0 },
      { binding_name: "DB_CMTY_FIXTURE", community_id: "cmt_B", allocated_at: "t0", last_error: null, released_at: null, version: 0 },
    ])
    const db = fakeD1()
    const env = envWith(db, { pool })

    // Sanity: the legitimate requests pass.
    await assertCommunityBinding(env, "cmt_A", "DB_CMTY_PILOT")
    await assertCommunityBinding(env, "cmt_B", "DB_CMTY_FIXTURE")

    // The poisoned request: community A claiming to read B's binding. The
    // env JSON is irrelevant — the pool is the source of truth.
    await expect(
      assertCommunityBinding(env, "cmt_A", "DB_CMTY_FIXTURE"),
    ).rejects.toMatchObject({ code: "shard_binding_not_allowed" })
  })

  test("second call within TTL is served from the in-memory cache (no second D1 lookup)", async () => {
    const pool = fakePoolD1()
    const db = fakeD1()
    const env = envWith(db, { pool })

    // First call: seed (SELECT COUNT) + lookup (SELECT WHERE community_id = ?).
    await assertCommunityBinding(env, "cmt_1", "DB_CMTY_PILOT")
    const callsAfterFirst = pool.calls.length
    expect(callsAfterFirst).toBeGreaterThan(0)

    // Second call: cache hit. No new D1 calls.
    await assertCommunityBinding(env, "cmt_1", "DB_CMTY_PILOT")
    expect(pool.calls.length).toBe(callsAfterFirst)
  })
})

test("runShardRead rejects a valid binding requested by the wrong community (never touches D1)", async () => {
  const db = fakeD1()
  await expect(
    runShardRead(envWith(db), { communityId: "cmt_other", bindingName: "DB_CMTY_PILOT", statement: "SELECT 1" }),
  ).rejects.toMatchObject({ code: "shard_binding_not_allowed" })
  expect(db.calls).toHaveLength(0)
})

describe("runShardWrite (atomic write batch)", () => {
  test("runs DML statements via db.batch and maps results", async () => {
    const db = fakeD1([{ ok: 1 }])
    const results = await runShardWrite(envWith(db), {
      communityId: "cmt_1",
      bindingName: "DB_CMTY_PILOT",
      statements: [
        { sql: "INSERT INTO t (id) VALUES (?1)", args: ["a"] },
        { sql: "UPDATE t SET n = 1 WHERE id = ?1", args: ["a"] },
      ],
    })
    expect(results).toHaveLength(2)
    expect(db.calls.map((c) => c.sql)).toEqual([
      "INSERT INTO t (id) VALUES (?1)",
      "UPDATE t SET n = 1 WHERE id = ?1",
    ])
  })

  test("rejects DDL on the write path (shard_write_not_allowed), never touches D1", async () => {
    const db = fakeD1()
    await expect(
      runShardWrite(envWith(db), {
        communityId: "cmt_1",
        bindingName: "DB_CMTY_PILOT",
        statements: [{ sql: "DROP TABLE t" }],
      }),
    ).rejects.toMatchObject({ code: "shard_write_not_allowed" })
    expect(db.calls).toHaveLength(0)
  })

  test("enforces the (community,binding) allowlist on writes too", async () => {
    const db = fakeD1()
    await expect(
      runShardWrite(envWith(db), {
        communityId: "cmt_other",
        bindingName: "DB_CMTY_PILOT",
        statements: [{ sql: "INSERT INTO t (id) VALUES (1)" }],
      }),
    ).rejects.toMatchObject({ code: "shard_binding_not_allowed" })
    expect(db.calls).toHaveLength(0)
  })

  test("rejects SELECT on the write path (reads use execute/batch)", async () => {
    const db = fakeD1()
    await expect(
      runShardWrite(envWith(db), { communityId: "cmt_1", bindingName: "DB_CMTY_PILOT", statements: [{ sql: "SELECT 1" }] }),
    ).rejects.toMatchObject({ code: "shard_write_not_allowed" })
    expect(db.calls).toHaveLength(0)
  })

  test("rejects unknown / non-DML leading verbs (BEGIN, EXPLAIN, gibberish)", async () => {
    for (const sql of ["BEGIN", "COMMIT", "EXPLAIN SELECT 1", "FROBNICATE t"]) {
      const db = fakeD1()
      await expect(
        runShardWrite(envWith(db), { communityId: "cmt_1", bindingName: "DB_CMTY_PILOT", statements: [{ sql }] }),
      ).rejects.toMatchObject({ code: "shard_write_not_allowed" })
      expect(db.calls).toHaveLength(0)
    }
  })

  test("accepts a write CTE (WITH ... INSERT)", async () => {
    const db = fakeD1()
    const r = await runShardWrite(envWith(db), {
      communityId: "cmt_1",
      bindingName: "DB_CMTY_PILOT",
      statements: [{ sql: "WITH src AS (SELECT 1 AS id) INSERT INTO t (id) SELECT id FROM src" }],
    })
    expect(r).toHaveLength(1)
    expect(db.calls).toHaveLength(1)
  })

  test("rejects a read-only CTE on the write path (WITH ... SELECT)", async () => {
    const db = fakeD1()
    await expect(
      runShardWrite(envWith(db), {
        communityId: "cmt_1",
        bindingName: "DB_CMTY_PILOT",
        statements: [{ sql: "WITH x AS (SELECT 1) SELECT * FROM x" }],
      }),
    ).rejects.toMatchObject({ code: "shard_write_not_allowed" })
    expect(db.calls).toHaveLength(0)
  })

  test("empty batch is a no-op", async () => {
    const db = fakeD1()
    expect(await runShardWrite(envWith(db), { communityId: "cmt_1", bindingName: "DB_CMTY_PILOT", statements: [] })).toEqual([])
    expect(db.calls).toHaveLength(0)
  })
})
