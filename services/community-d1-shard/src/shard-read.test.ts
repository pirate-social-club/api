import { beforeEach, describe, expect, test } from "bun:test"
import {
  assertCommunityBinding,
  QUARANTINE_WINDOW_MS,
  POOL_CACHE_TTL_MS,
  POOL_CACHE_SHORT_TTL_MS,
  resetPoolCacheForTests,
  resolveD1,
  runShardBatch,
  runShardBind,
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
 * Minimal in-memory fake of the d1_pool D1. Supports the queries
 * assertCommunityBinding, ensurePoolSeeded, and runShardBind actually issue:
 *   - SELECT COUNT(*) AS n FROM d1_pool
 *   - SELECT binding_name, last_error FROM d1_pool WHERE community_id = ?1
 *   - SELECT binding_name, version FROM d1_pool WHERE community_id IS NULL ... (free-pool scan)
 *   - INSERT OR IGNORE INTO d1_pool (...) VALUES (...)
 *   - UPDATE d1_pool SET ... WHERE binding_name = ? AND version = ? (optimistic lock)
 *   - UPDATE d1_pool SET last_error = ? WHERE binding_name = ? AND version = ?
 *
 * The `simulateUniqueCommunityIdViolation` flag, when set, makes the next
 * community-claiming UPDATE throw a SQLITE_CONSTRAINT_UNIQUE error — used by
 * the concurrent-allocator test (§8.3).
 */
function fakePoolD1(
  initialRows: FakePoolRow[] = [],
  options?: { simulateUniqueCommunityIdViolation?: boolean },
) {
  const calls: FakeCall[] = []
  const rows: FakePoolRow[] = [...initialRows]
  const opts = { simulateUniqueCommunityIdViolation: false, ...options }
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
        // Both assertCommunityBinding ("SELECT binding_name, last_error") and
        // runShardBind ("SELECT binding_name") query by community_id — match
        // the WHERE clause and ignore the column list.
        if (/FROM d1_pool\s+WHERE community_id = \?1/.test(sql)) {
          const communityId = s._args[0] as string
          return rows.find((r) => r.community_id === communityId) ?? null
        }
        if (/FROM d1_pool\s+WHERE community_id IS NULL/.test(sql)) {
          const quarantineThreshold = s._args[0] as string
          const free = rows
            .filter(
              (r) =>
                r.community_id === null &&
                (r.released_at === null || r.released_at < quarantineThreshold),
            )
            .sort((a, b) => a.binding_name.localeCompare(b.binding_name))[0]
          return free ?? null
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
        if (/UPDATE d1_pool SET last_error = \?2/.test(sql)) {
          const [binding_name, _last_error, _version] = s._args as [string, string, number]
          const row = rows.find((r) => r.binding_name === binding_name)
          if (row) {
            row.last_error = _last_error
            row.version += 1
            return { success: true, meta: { changes: 1, last_row_id: 0 } }
          }
          return { success: true, meta: { changes: 0, last_row_id: 0 } }
        }
        if (/UPDATE d1_pool SET\s+community_id = \?2/.test(sql)) {
          // Optimistic-lock UPDATE: claim a free binding for a communityId.
          const [binding_name, community_id, allocated_at, version] = s._args as [
            string,
            string,
            string,
            number,
          ]
          if (opts.simulateUniqueCommunityIdViolation) {
            opts.simulateUniqueCommunityIdViolation = false
            // Simulate the race: a concurrent allocator already claimed
            // community_id. Mutate the row to reflect the winner's state, then
            // throw the UNIQUE violation. The loser's re-query (SELECT WHERE
            // community_id = X) will find this row and return the winner's
            // binding with allocated: false.
            const winnerRow = rows.find((r) => r.binding_name === binding_name)
            if (winnerRow) {
              winnerRow.community_id = community_id
              winnerRow.allocated_at = allocated_at
              winnerRow.released_at = null
              winnerRow.last_loaded_at = null
              winnerRow.last_error = null
              winnerRow.version += 1
            }
            const e = new Error(
              "UNIQUE constraint failed: d1_pool.community_id",
            ) as Error & { rawCode?: string; code?: string }
            e.rawCode = "SQLITE_CONSTRAINT_UNIQUE"
            e.code = "SQLITE_CONSTRAINT_UNIQUE"
            throw e
          }
          const row = rows.find((r) => r.binding_name === binding_name)
          if (!row || row.version !== version || row.community_id !== null) {
            return { success: true, meta: { changes: 0, last_row_id: 0 } }
          }
          row.community_id = community_id
          row.allocated_at = allocated_at
          row.released_at = null
          row.last_loaded_at = null
          row.last_error = null
          row.version += 1
          return { success: true, meta: { changes: 1, last_row_id: 0 } }
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

describe("runShardBind (step 2 — d1_pool allocator)", () => {
  const NOW = "2026-06-19T12:00:00Z"
  const SHARD_ID = "community-d1-shard-staging"

  function envForAllocator(
    pool: FakePoolD1,
    extraBindings: Record<string, unknown> = {},
  ): ShardEnv {
    return {
      ...envWith(fakeD1(), { pool }),
      ...extraBindings,
    } as ShardEnv
  }

  test("§8.3 — allocates a free binding for an unknown community (allocated: true)", async () => {
    // 2 already-allocated pilots + 1 free binding (NEW_DB).
    const pool = fakePoolD1([
      { binding_name: "DB_CMTY_PILOT", community_id: "cmt_pilot", allocated_at: "t0", last_error: null, released_at: null, version: 0 },
      { binding_name: "DB_CMTY_FIXTURE", community_id: "cmt_fixture", allocated_at: "t0", last_error: null, released_at: null, version: 0 },
      { binding_name: "DB_CMTY_NEW", community_id: null, allocated_at: null, last_error: null, released_at: null, version: 0 },
    ])
    const env = envForAllocator(pool, { DB_CMTY_NEW: fakeD1() as unknown as D1Database })
    const r = await runShardBind(env, { communityId: "cmt_new", now: NOW })
    expect(r).toEqual({ bindingName: "DB_CMTY_NEW", shardWorkerId: SHARD_ID, allocated: true })
    // Pool row is now claimed.
    const claimed = pool.rows.find((row) => row.binding_name === "DB_CMTY_NEW")
    expect(claimed?.community_id).toBe("cmt_new")
    expect(claimed?.allocated_at).toBe(NOW)
  })

  test("§8.3 — idempotency: second call for the same community returns the same binding, allocated: false", async () => {
    const pool = fakePoolD1([
      { binding_name: "DB_CMTY_NEW", community_id: "cmt_new", allocated_at: NOW, last_error: null, released_at: null, version: 1 },
    ])
    const env = envForAllocator(pool, { DB_CMTY_NEW: fakeD1() as unknown as D1Database })
    const r1 = await runShardBind(env, { communityId: "cmt_new", now: NOW })
    const r2 = await runShardBind(env, { communityId: "cmt_new", now: NOW })
    expect(r1).toEqual({ bindingName: "DB_CMTY_NEW", shardWorkerId: SHARD_ID, allocated: false })
    expect(r2).toEqual({ bindingName: "DB_CMTY_NEW", shardWorkerId: SHARD_ID, allocated: false })
  })

  test("§8.3 — concurrent allocation: UNIQUE(community_id) violation is caught and the winner's binding is returned", async () => {
    // Simulate a race: the allocator sees no row for communityId X (initial
    // SELECT returns null), picks the free row, but a concurrent allocator
    // already won — the fake's UPDATE mutates the row to the winner's state
    // AND throws the UNIQUE violation. The loser's re-query (SELECT WHERE
    // community_id = X) finds the winner's row and returns it with
    // allocated: false.
    const pool = fakePoolD1(
      [
        { binding_name: "DB_CMTY_NEW", community_id: null, allocated_at: null, last_error: null, released_at: null, version: 0 },
      ],
      { simulateUniqueCommunityIdViolation: true },
    )
    const env = envForAllocator(pool, { DB_CMTY_NEW: fakeD1() as unknown as D1Database })
    const r = await runShardBind(env, { communityId: "cmt_new", now: NOW })
    expect(r.allocated).toBe(false)
    expect(r.bindingName).toBe("DB_CMTY_NEW")
  })

  test("rejects with shard_pool_exhausted when the pool has no free bindings", async () => {
    const pool = fakePoolD1([
      { binding_name: "DB_CMTY_PILOT", community_id: "cmt_pilot", allocated_at: "t0", last_error: null, released_at: null, version: 0 },
      { binding_name: "DB_CMTY_FIXTURE", community_id: "cmt_fixture", allocated_at: "t0", last_error: null, released_at: null, version: 0 },
    ])
    const env = envForAllocator(pool, { DB_CMTY_PILOT: fakeD1(), DB_CMTY_FIXTURE: fakeD1() })
    await expect(runShardBind(env, { communityId: "cmt_new", now: NOW })).rejects.toMatchObject({
      code: "shard_pool_exhausted",
    })
  })

  test("respects the quarantine window: a recently released binding is not allocated", async () => {
    // The released_at is in the future relative to (now - QUARANTINE_WINDOW_MS).
    // The free-pool filter excludes it.
    const justReleased = new Date(Date.now() - 1000).toISOString() // 1s ago — within quarantine
    const pool = fakePoolD1([
      {
        binding_name: "DB_CMTY_NEW",
        community_id: null,
        allocated_at: null,
        last_error: null,
        released_at: justReleased,
        version: 0,
      },
    ])
    const env = envForAllocator(pool, { DB_CMTY_NEW: fakeD1() })
    await expect(runShardBind(env, { communityId: "cmt_new", now: NOW })).rejects.toMatchObject({
      code: "shard_pool_exhausted",
    })
  })

  test("a binding past the quarantine window is allocatable", async () => {
    const longAgoReleased = new Date(Date.now() - QUARANTINE_WINDOW_MS - 60_000).toISOString()
    const pool = fakePoolD1([
      {
        binding_name: "DB_CMTY_NEW",
        community_id: null,
        allocated_at: null,
        last_error: null,
        released_at: longAgoReleased,
        version: 0,
      },
    ])
    const env = envForAllocator(pool, { DB_CMTY_NEW: fakeD1() })
    const r = await runShardBind(env, { communityId: "cmt_new", now: NOW })
    expect(r.allocated).toBe(true)
    expect(r.bindingName).toBe("DB_CMTY_NEW")
  })

  test("rejects with shard_binding_not_initialized when the pool row's binding isn't actually bound on this Worker", async () => {
    const pool = fakePoolD1([
      { binding_name: "DB_CMTY_ORPHAN", community_id: null, allocated_at: null, last_error: null, released_at: null, version: 0 },
    ])
    // envForAllocator only has DB_CMTY_PILOT / DB_CMTY_FIXTURE bound — no DB_CMTY_ORPHAN.
    const env = envForAllocator(pool)
    await expect(runShardBind(env, { communityId: "cmt_new", now: NOW })).rejects.toMatchObject({
      code: "shard_binding_not_initialized",
    })
    // last_error recorded for ops visibility.
    const orphan = pool.rows.find((r) => r.binding_name === "DB_CMTY_ORPHAN")
    expect(orphan?.last_error).toMatch(/not initialized/i)
  })

  test("rejects with shard_unknown_binding when D1_POOL is absent", async () => {
    const env = {
      DB_CMTY_PILOT: fakeD1() as unknown as D1Database,
      COMMUNITY_D1_SHARD_WORKER_ID: SHARD_ID,
    } as ShardEnv
    await expect(runShardBind(env, { communityId: "cmt_new", now: NOW })).rejects.toMatchObject({
      code: "shard_unknown_binding",
    })
  })

  test("shardWorkerId defaults to 'community-d1-shard-staging' when COMMUNITY_D1_SHARD_WORKER_ID is not set", async () => {
    const pool = fakePoolD1([
      { binding_name: "DB_CMTY_NEW", community_id: null, allocated_at: null, last_error: null, released_at: null, version: 0 },
    ])
    const env = {
      DB_CMTY_PILOT: fakeD1() as unknown as D1Database,
      DB_CMTY_NEW: fakeD1() as unknown as D1Database,
      D1_POOL: pool as unknown as D1Database,
    } as ShardEnv
    const r = await runShardBind(env, { communityId: "cmt_new", now: NOW })
    expect(r.shardWorkerId).toBe("community-d1-shard-staging")
  })
})
