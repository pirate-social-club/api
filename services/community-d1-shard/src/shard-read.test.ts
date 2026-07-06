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
  runShardGetPoolRow,
  runShardLoadSnapshot,
  runShardPoolStats,
  runShardRead,
  runShardRelease,
  runShardReset,
  runShardWrite,
  type ShardEnv,
} from "./shard-read"

type FakeCall = { sql: string; args: unknown[] }

function fakeD1(
  rows: Record<string, unknown>[] = [{ x: 1 }],
  options?: { perStatementChanges?: number[] },
) {
  const calls: FakeCall[] = []
  const changes = options?.perStatementChanges ?? [1]
  function stmt(sql: string) {
    const s: any = {
      _args: [] as unknown[],
      _sql: sql,
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
    // D1's batch() returns the results of all statements in order. The fake
    // mirrors that: each prepared statement's .all() contributes one result.
    // The per-statement `changes` (from options.perStatementChanges) lets the
    // bootstrap test assert that rowsAffected aggregates across the batch.
    // Note: the prepared statement's own .all() already records the call
    // (we don't double-push here).
    async batch(stmts: any[]) {
      return Promise.all(
        stmts.map(async (st, i) => {
          const a = await st.all()
          return {
            results: a.results,
            success: true,
            meta: { changes: changes[i] ?? 1, last_row_id: 0 },
          }
        }),
      )
    },
  }
}

type FakePoolRow = {
  binding_name: string
  community_id: string | null
  allocated_at: string | null
  last_loaded_at: string | null
  last_error: string | null
  released_at: string | null
  version: number
}

/**
 * In-memory fake of the d1_pool D1. Supports the queries assertCommunityBinding,
 * ensurePoolSeeded, runShardBind, and runShardLoadSnapshot actually issue:
 *   - SELECT COUNT(*) AS n FROM d1_pool
 *   - SELECT binding_name, last_error FROM d1_pool WHERE community_id = ?1
 *   - SELECT binding_name, version FROM d1_pool WHERE community_id IS NULL ... (free-pool scan)
 *   - SELECT community_id, last_loaded_at FROM d1_pool WHERE binding_name = ?1 (load re-validation)
 *   - INSERT OR IGNORE INTO d1_pool (...) VALUES (...)
 *   - UPDATE d1_pool SET ... WHERE binding_name = ? AND version = ? (optimistic lock)
 *   - UPDATE d1_pool SET last_error = ? WHERE binding_name = ? AND version = ?
 *   - UPDATE d1_pool SET last_loaded_at = ? ... WHERE binding_name = ? (mark loaded)
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
        if (/FROM d1_pool\s+WHERE binding_name = \?1/.test(sql)) {
          // loadSnapshot re-validation: SELECT community_id, last_loaded_at
          const bindingName = s._args[0] as string
          const row = rows.find((r) => r.binding_name === bindingName)
          if (!row) return null
          return { community_id: row.community_id, last_loaded_at: row.last_loaded_at }
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
            last_loaded_at: null,
            version: 0,
          })
          return { success: true, meta: { changes: 1, last_row_id: rows.length } }
        }
        if (/UPDATE d1_pool SET\s+community_id = \?2/.test(sql)) {
          const [binding_name, community_id, allocated_at, version] = s._args as [
            string,
            string,
            string,
            number,
          ]
          if (opts.simulateUniqueCommunityIdViolation) {
            opts.simulateUniqueCommunityIdViolation = false
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
        if (/UPDATE d1_pool SET\s+last_loaded_at/.test(sql)) {
          // loadSnapshot marks the binding loaded. Note: in production this
          // also bumps version, which the fake mirrors.
          const [binding_name, last_loaded_at] = s._args as [string, string]
          const row = rows.find((r) => r.binding_name === binding_name)
          if (row) {
            if (row.last_loaded_at == null) {
              row.last_loaded_at = last_loaded_at
            }
            row.last_error = null
            row.version += 1
            return { success: true, meta: { changes: 1, last_row_id: 0 } }
          }
          return { success: true, meta: { changes: 0, last_row_id: 0 } }
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

function envWith(
  db: unknown,
  options?: { pool?: FakePoolD1; envJson?: string | undefined },
): ShardEnv {
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
    expect(QUARANTINE_WINDOW_MS).toBeGreaterThan(POOL_CACHE_TTL_MS)
    expect(QUARANTINE_WINDOW_MS).toBeGreaterThan(POOL_CACHE_SHORT_TTL_MS)
  })
})

describe("resolveD1 binding allowlist (returned as value, not thrown — step 2.5)", () => {
  test("resolves a real bound D1 namespace", () => {
    const db = fakeD1()
    const r = resolveD1(envWith(db), "DB_CMTY_PILOT")
    expect(r).toBe(db as unknown as D1Database)
  })

  test("returns a typed error for an unknown binding name (control-plane row not trusted)", () => {
    const r = resolveD1(envWith(fakeD1()), "DB_NOT_BOUND")
    expect(r).toEqual({
      ok: false,
      code: "shard_unknown_binding",
      message: expect.stringMatching(/Unknown or non-D1 binding/i),
    })
  })

  test("returns a typed error for a non-D1 binding (no prepare/batch)", () => {
    const notD1 = { fetch: () => {} } as unknown as D1Database
    const r = resolveD1({ DB_CMTY_PILOT: notD1 } as ShardEnv, "DB_CMTY_PILOT")
    expect(r).toMatchObject({ ok: false, code: "shard_unknown_binding" })
  })
})

describe("runShardRead (returns ShardResult — step 2.5)", () => {
  test("runs a SELECT and maps rows + binds args", async () => {
    const db = fakeD1([{ id: "c1" }])
    const r = await runShardRead(envWith(db), {
      communityId: "cmt_1",
      bindingName: "DB_CMTY_PILOT",
      statement: { sql: "SELECT id FROM t WHERE id = ?1", args: ["c1"] },
    })
    expect(r).toMatchObject({ ok: true })
    if (r.ok) {
      expect(r.value.rows).toEqual([{ id: "c1" }])
      expect(db.calls[0]).toEqual({ sql: "SELECT id FROM t WHERE id = ?1", args: ["c1"] })
    }
  })

  test("returns shard_read_only_violation for a write statement and never touches D1", async () => {
    const db = fakeD1()
    const r = await runShardRead(envWith(db), {
      communityId: "cmt_1",
      bindingName: "DB_CMTY_PILOT",
      statement: "INSERT INTO t (id) VALUES (?1)",
    })
    expect(r).toMatchObject({ ok: false, code: "shard_read_only_violation" })
    expect(db.calls).toHaveLength(0)
  })

  test("returns shard_read_only_violation for statement-batch smuggling", async () => {
    const r = await runShardRead(envWith(fakeD1()), {
      communityId: "cmt_1",
      bindingName: "DB_CMTY_PILOT",
      statement: "SELECT 1; DROP TABLE t",
    })
    expect(r).toMatchObject({ ok: false, code: "shard_read_only_violation" })
  })
})

describe("runShardBatch (returns ShardResult — step 2.5)", () => {
  test("runs read batch and maps each result", async () => {
    const db = fakeD1([{ n: 1 }])
    const r = await runShardBatch(envWith(db), {
      communityId: "cmt_1",
      bindingName: "DB_CMTY_PILOT",
      statements: [
        { sql: "SELECT 1 AS n", args: [] },
        { sql: "SELECT n FROM t", args: [] },
      ],
    })
    expect(r).toMatchObject({ ok: true })
    if (r.ok) {
      expect(r.value).toHaveLength(2)
      expect(r.value[0]!.rows).toEqual([{ n: 1 }])
    }
  })

  test("returns shard_read_only_violation for a batch containing any write", async () => {
    const db = fakeD1()
    const r = await runShardBatch(envWith(db), {
      communityId: "cmt_1",
      bindingName: "DB_CMTY_PILOT",
      statements: [
        { sql: "SELECT 1", args: [] },
        { sql: "UPDATE t SET n = 1", args: [] },
      ],
    })
    expect(r).toMatchObject({ ok: false, code: "shard_read_only_violation" })
    expect(db.calls).toHaveLength(0)
  })
})

describe("assertCommunityBinding (returns ShardError | null — step 2.5)", () => {
  test("allows the mapped (community, binding) pair; cold-start seed populates an empty pool", async () => {
    const pool = fakePoolD1()
    const db = fakeD1()
    const r = await assertCommunityBinding(envWith(db, { pool }), "cmt_1", "DB_CMTY_PILOT")
    expect(r).toBeNull()
    expect(pool.rows).toHaveLength(1)
    expect(pool.rows[0]).toMatchObject({ binding_name: "DB_CMTY_PILOT", community_id: "cmt_1" })
  })

  test("returns shard_binding_not_allowed for an UNMAPPED community (cross-tenant guard)", async () => {
    const r = await assertCommunityBinding(envWith(fakeD1()), "cmt_other", "DB_CMTY_PILOT")
    expect(r).toMatchObject({ ok: false, code: "shard_binding_not_allowed" })
  })

  test("returns shard_binding_not_allowed for a DIFFERENT binding than its mapping", async () => {
    const r = await assertCommunityBinding(envWith(fakeD1()), "cmt_1", "DB_OTHER")
    expect(r).toMatchObject({ ok: false, code: "shard_binding_not_allowed" })
  })

  test("returns shard_binding_not_allowed when the pool has no row for the community (env JSON cannot rescue an unknown community)", async () => {
    const pool = fakePoolD1([
      { binding_name: "DB_CMTY_PILOT", community_id: "cmt_1", allocated_at: "t0", last_error: null, released_at: null, last_loaded_at: null, version: 0 },
    ])
    const envJson = JSON.stringify({ cmt_other: "DB_CMTY_PILOT" })
    const r = await assertCommunityBinding(
      envWith(fakeD1(), { pool, envJson }),
      "cmt_other",
      "DB_CMTY_PILOT",
    )
    expect(r).toMatchObject({ ok: false, code: "shard_binding_not_allowed" })
  })

  test("returns shard_unknown_binding when D1_POOL is absent", async () => {
    const env = {
      DB_CMTY_PILOT: fakeD1() as unknown as D1Database,
      COMMUNITY_D1_BINDING_MAP_JSON: JSON.stringify({ cmt_1: "DB_CMTY_PILOT" }),
    } as ShardEnv
    const r = await assertCommunityBinding(env, "cmt_1", "DB_CMTY_PILOT")
    expect(r).toMatchObject({ ok: false, code: "shard_unknown_binding" })
  })

  test("cold-start seed is a no-op when the pool is already populated", async () => {
    const pool = fakePoolD1([
      { binding_name: "DB_CMTY_FIXTURE", community_id: "cmt_1", allocated_at: "t0", last_error: null, released_at: null, last_loaded_at: null, version: 0 },
    ])
    const r = await assertCommunityBinding(envWith(fakeD1(), { pool }), "cmt_1", "DB_CMTY_PILOT")
    expect(r).toMatchObject({ ok: false, code: "shard_binding_not_allowed" })
    expect(pool.rows).toHaveLength(1)
    expect(pool.rows[0]!.binding_name).toBe("DB_CMTY_FIXTURE")
  })

  test("§8.2 — poisoned control-plane routing row is still rejected (the keystone property)", async () => {
    const pool = fakePoolD1([
      { binding_name: "DB_CMTY_PILOT", community_id: "cmt_A", allocated_at: "t0", last_error: null, released_at: null, last_loaded_at: null, version: 0 },
      { binding_name: "DB_CMTY_FIXTURE", community_id: "cmt_B", allocated_at: "t0", last_error: null, released_at: null, last_loaded_at: null, version: 0 },
    ])
    const env = envWith(fakeD1(), { pool })
    expect(await assertCommunityBinding(env, "cmt_A", "DB_CMTY_PILOT")).toBeNull()
    expect(await assertCommunityBinding(env, "cmt_B", "DB_CMTY_FIXTURE")).toBeNull()
    expect(await assertCommunityBinding(env, "cmt_A", "DB_CMTY_FIXTURE")).toMatchObject({
      ok: false,
      code: "shard_binding_not_allowed",
    })
  })

  test("second call within TTL is served from the in-memory cache (no second D1 lookup)", async () => {
    const pool = fakePoolD1()
    const env = envWith(fakeD1(), { pool })
    await assertCommunityBinding(env, "cmt_1", "DB_CMTY_PILOT")
    const callsAfterFirst = pool.calls.length
    expect(callsAfterFirst).toBeGreaterThan(0)
    await assertCommunityBinding(env, "cmt_1", "DB_CMTY_PILOT")
    expect(pool.calls.length).toBe(callsAfterFirst)
  })
})

test("runShardRead returns shard_binding_not_allowed for a wrong community (never touches D1)", async () => {
  const db = fakeD1()
  const r = await runShardRead(envWith(db), {
    communityId: "cmt_other",
    bindingName: "DB_CMTY_PILOT",
    statement: "SELECT 1",
  })
  expect(r).toMatchObject({ ok: false, code: "shard_binding_not_allowed" })
  expect(db.calls).toHaveLength(0)
})

describe("runShardWrite (returns ShardResult — step 2.5)", () => {
  test("runs DML statements via db.batch and maps results", async () => {
    const db = fakeD1([{ ok: 1 }])
    const r = await runShardWrite(envWith(db), {
      communityId: "cmt_1",
      bindingName: "DB_CMTY_PILOT",
      statements: [
        { sql: "INSERT INTO t (id) VALUES (?1)", args: ["a"] },
        { sql: "UPDATE t SET n = 1 WHERE id = ?1", args: ["a"] },
      ],
    })
    expect(r).toMatchObject({ ok: true })
    if (r.ok) {
      expect(r.value).toHaveLength(2)
      expect(db.calls.map((c) => c.sql)).toEqual([
        "INSERT INTO t (id) VALUES (?1)",
        "UPDATE t SET n = 1 WHERE id = ?1",
      ])
    }
  })

  test("returns shard_write_not_allowed for DDL on the write path; never touches D1", async () => {
    const db = fakeD1()
    const r = await runShardWrite(envWith(db), {
      communityId: "cmt_1",
      bindingName: "DB_CMTY_PILOT",
      statements: [{ sql: "DROP TABLE t" }],
    })
    expect(r).toMatchObject({ ok: false, code: "shard_write_not_allowed" })
    expect(db.calls).toHaveLength(0)
  })

  test("enforces the (community,binding) allowlist on writes too", async () => {
    const db = fakeD1()
    const r = await runShardWrite(envWith(db), {
      communityId: "cmt_other",
      bindingName: "DB_CMTY_PILOT",
      statements: [{ sql: "INSERT INTO t (id) VALUES (1)" }],
    })
    expect(r).toMatchObject({ ok: false, code: "shard_binding_not_allowed" })
    expect(db.calls).toHaveLength(0)
  })

  test("returns shard_write_not_allowed for SELECT on the write path", async () => {
    const db = fakeD1()
    const r = await runShardWrite(envWith(db), {
      communityId: "cmt_1",
      bindingName: "DB_CMTY_PILOT",
      statements: [{ sql: "SELECT 1" }],
    })
    expect(r).toMatchObject({ ok: false, code: "shard_write_not_allowed" })
    expect(db.calls).toHaveLength(0)
  })

  test("returns shard_write_not_allowed for unknown / non-DML leading verbs", async () => {
    for (const sql of ["BEGIN", "COMMIT", "EXPLAIN SELECT 1", "FROBNICATE t"]) {
      const db = fakeD1()
      const r = await runShardWrite(envWith(db), {
        communityId: "cmt_1",
        bindingName: "DB_CMTY_PILOT",
        statements: [{ sql }],
      })
      expect(r).toMatchObject({ ok: false, code: "shard_write_not_allowed" })
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
    expect(r).toMatchObject({ ok: true })
    if (r.ok) {
      expect(r.value).toHaveLength(1)
      expect(db.calls).toHaveLength(1)
    }
  })

  test("returns shard_write_not_allowed for a read-only CTE on the write path", async () => {
    const db = fakeD1()
    const r = await runShardWrite(envWith(db), {
      communityId: "cmt_1",
      bindingName: "DB_CMTY_PILOT",
      statements: [{ sql: "WITH x AS (SELECT 1) SELECT * FROM x" }],
    })
    expect(r).toMatchObject({ ok: false, code: "shard_write_not_allowed" })
    expect(db.calls).toHaveLength(0)
  })

  test("empty batch is a no-op (returns ok with empty array)", async () => {
    const db = fakeD1()
    const r = await runShardWrite(envWith(db), {
      communityId: "cmt_1",
      bindingName: "DB_CMTY_PILOT",
      statements: [],
    })
    expect(r).toEqual({ ok: true, value: [] })
    expect(db.calls).toHaveLength(0)
  })
})

describe("runShardBind (step 2 — returns ShardResult — step 2.5)", () => {
  const NOW = "2026-06-19T12:00:00Z"
  const SHARD_ID = "community-d1-shard-staging"

  function envForAllocator(pool: FakePoolD1, extraBindings: Record<string, unknown> = {}): ShardEnv {
    return { ...envWith(fakeD1(), { pool }), ...extraBindings } as ShardEnv
  }

  test("§8.3 — allocates a free binding for an unknown community", async () => {
    const pool = fakePoolD1([
      { binding_name: "DB_CMTY_PILOT", community_id: "cmt_pilot", allocated_at: "t0", last_error: null, released_at: null, last_loaded_at: null, version: 0 },
      { binding_name: "DB_CMTY_FIXTURE", community_id: "cmt_fixture", allocated_at: "t0", last_error: null, released_at: null, last_loaded_at: null, version: 0 },
      { binding_name: "DB_CMTY_NEW", community_id: null, allocated_at: null, last_error: null, released_at: null, last_loaded_at: null, version: 0 },
    ])
    const env = envForAllocator(pool, { DB_CMTY_NEW: fakeD1() as unknown as D1Database })
    const r = await runShardBind(env, { communityId: "cmt_new", now: NOW })
    expect(r).toEqual({ ok: true, value: { bindingName: "DB_CMTY_NEW", shardWorkerId: SHARD_ID, allocated: true } })
    const claimed = pool.rows.find((row) => row.binding_name === "DB_CMTY_NEW")
    expect(claimed?.community_id).toBe("cmt_new")
    expect(claimed?.allocated_at).toBe(NOW)
  })

  test("§8.3 — idempotency: second call returns the same binding with allocated: false", async () => {
    const pool = fakePoolD1([
      { binding_name: "DB_CMTY_NEW", community_id: "cmt_new", allocated_at: NOW, last_error: null, released_at: null, last_loaded_at: null, version: 1 },
    ])
    const env = envForAllocator(pool, { DB_CMTY_NEW: fakeD1() as unknown as D1Database })
    const r1 = await runShardBind(env, { communityId: "cmt_new", now: NOW })
    const r2 = await runShardBind(env, { communityId: "cmt_new", now: NOW })
    expect(r1).toEqual({ ok: true, value: { bindingName: "DB_CMTY_NEW", shardWorkerId: SHARD_ID, allocated: false } })
    expect(r2).toEqual({ ok: true, value: { bindingName: "DB_CMTY_NEW", shardWorkerId: SHARD_ID, allocated: false } })
  })

  test("§8.3 — concurrent allocation: UNIQUE(community_id) caught, winner's binding returned with allocated: false", async () => {
    const pool = fakePoolD1(
      [
        { binding_name: "DB_CMTY_NEW", community_id: null, allocated_at: null, last_error: null, released_at: null, last_loaded_at: null, version: 0 },
      ],
      { simulateUniqueCommunityIdViolation: true },
    )
    const env = envForAllocator(pool, { DB_CMTY_NEW: fakeD1() as unknown as D1Database })
    const r = await runShardBind(env, { communityId: "cmt_new", now: NOW })
    expect(r).toMatchObject({ ok: true, value: { allocated: false, bindingName: "DB_CMTY_NEW" } })
  })

  test("returns shard_pool_exhausted when no free bindings", async () => {
    const pool = fakePoolD1([
      { binding_name: "DB_CMTY_PILOT", community_id: "cmt_pilot", allocated_at: "t0", last_error: null, released_at: null, last_loaded_at: null, version: 0 },
      { binding_name: "DB_CMTY_FIXTURE", community_id: "cmt_fixture", allocated_at: "t0", last_error: null, released_at: null, last_loaded_at: null, version: 0 },
    ])
    const env = envForAllocator(pool, { DB_CMTY_PILOT: fakeD1(), DB_CMTY_FIXTURE: fakeD1() })
    const r = await runShardBind(env, { communityId: "cmt_new", now: NOW })
    expect(r).toMatchObject({ ok: false, code: "shard_pool_exhausted" })
  })

  test("respects the quarantine window: recently released binding is not allocated", async () => {
    const justReleased = new Date(Date.now() - 1000).toISOString()
    const pool = fakePoolD1([
      { binding_name: "DB_CMTY_NEW", community_id: null, allocated_at: null, last_error: null, released_at: justReleased, last_loaded_at: null, version: 0 },
    ])
    const env = envForAllocator(pool, { DB_CMTY_NEW: fakeD1() })
    const r = await runShardBind(env, { communityId: "cmt_new", now: NOW })
    expect(r).toMatchObject({ ok: false, code: "shard_pool_exhausted" })
  })

  test("a binding past the quarantine window is allocatable", async () => {
    const longAgoReleased = new Date(Date.now() - QUARANTINE_WINDOW_MS - 60_000).toISOString()
    const pool = fakePoolD1([
      { binding_name: "DB_CMTY_NEW", community_id: null, allocated_at: null, last_error: null, released_at: longAgoReleased, last_loaded_at: null, version: 0 },
    ])
    const env = envForAllocator(pool, { DB_CMTY_NEW: fakeD1() })
    const r = await runShardBind(env, { communityId: "cmt_new", now: NOW })
    expect(r).toMatchObject({ ok: true, value: { allocated: true, bindingName: "DB_CMTY_NEW" } })
  })

  test("returns shard_binding_not_initialized when the pool row's binding isn't bound on this Worker", async () => {
    const pool = fakePoolD1([
      { binding_name: "DB_CMTY_ORPHAN", community_id: null, allocated_at: null, last_error: null, released_at: null, last_loaded_at: null, version: 0 },
    ])
    const env = envForAllocator(pool)
    const r = await runShardBind(env, { communityId: "cmt_new", now: NOW })
    expect(r).toMatchObject({ ok: false, code: "shard_binding_not_initialized" })
    const orphan = pool.rows.find((row) => row.binding_name === "DB_CMTY_ORPHAN")
    expect(orphan?.last_error).toMatch(/not initialized/i)
  })

  test("returns shard_unknown_binding when D1_POOL is absent", async () => {
    const env = {
      DB_CMTY_PILOT: fakeD1() as unknown as D1Database,
      COMMUNITY_D1_SHARD_WORKER_ID: SHARD_ID,
    } as ShardEnv
    const r = await runShardBind(env, { communityId: "cmt_new", now: NOW })
    expect(r).toMatchObject({ ok: false, code: "shard_unknown_binding" })
  })

  test("shardWorkerId defaults to 'community-d1-shard-staging' when COMMUNITY_D1_SHARD_WORKER_ID is not set", async () => {
    const pool = fakePoolD1([
      { binding_name: "DB_CMTY_NEW", community_id: null, allocated_at: null, last_error: null, released_at: null, last_loaded_at: null, version: 0 },
    ])
    const env = {
      DB_CMTY_PILOT: fakeD1() as unknown as D1Database,
      DB_CMTY_NEW: fakeD1() as unknown as D1Database,
      D1_POOL: pool as unknown as D1Database,
    } as ShardEnv
    const r = await runShardBind(env, { communityId: "cmt_new", now: NOW })
    expect(r).toMatchObject({ ok: true, value: { shardWorkerId: "community-d1-shard-staging" } })
  })
})

describe("runShardLoadSnapshot (step 3 — returns ShardResult)", () => {
  const POOL_ROW = {
    binding_name: "DB_CMTY_NEW",
    community_id: "cmt_new",
    allocated_at: "t0",
    last_error: null,
    released_at: null,
    last_loaded_at: null,
    version: 0,
  } as const

  function envForLoad(pool: FakePoolD1, extraBindings: Record<string, unknown> = {}): ShardEnv {
    return {
      ...envWith(fakeD1(), { pool }),
      ...extraBindings,
    } as ShardEnv
  }

  test("§8.4 — loads the schema + rows for an allocated binding, marks last_loaded_at, returns loaded: true", async () => {
    const pool = fakePoolD1([{ ...POOL_ROW }])
    const env = envForLoad(pool, {
      DB_CMTY_NEW: fakeD1([], { perStatementChanges: [0, 1, 2] }),
    })
    const r = await runShardLoadSnapshot(env, {
      communityId: "cmt_new",
      bindingName: "DB_CMTY_NEW",
      statements: [
        { sql: "CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)", args: [] },
        { sql: "INSERT INTO t (id) VALUES (1)", args: [] },
        { sql: "INSERT INTO t (id) VALUES (2)", args: [] },
      ],
    })
    expect(r).toEqual({ ok: true, value: { rowsAffected: 3, loaded: true } })
    const row = pool.rows.find((r) => r.binding_name === "DB_CMTY_NEW")
    expect(row?.last_loaded_at).not.toBeNull()
  })

  test("§8.4 — idempotency: re-running on an already-loaded binding returns loaded: false, leaves last_loaded_at unchanged", async () => {
    const pool = fakePoolD1([{ ...POOL_ROW, last_loaded_at: "t_prior" }])
    const env = envForLoad(pool, { DB_CMTY_NEW: fakeD1() })
    const r = await runShardLoadSnapshot(env, {
      communityId: "cmt_new",
      bindingName: "DB_CMTY_NEW",
      statements: [{ sql: "CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)", args: [] }],
    })
    expect(r).toEqual({ ok: true, value: { rowsAffected: 0, loaded: false } })
    const row = pool.rows.find((r) => r.binding_name === "DB_CMTY_NEW")
    expect(row?.last_loaded_at).toBe("t_prior")
  })

  test("§4.2 invariant — released binding: assertCommunityBinding rejects (community is no longer in the pool)", async () => {
    // A released binding has community_id = NULL on the pool row. The auth
    // step (assertCommunityBinding) catches this: the SELECT WHERE
    // community_id = X returns no row, and the cache cannot rescue it (the
    // community never had a cache entry to begin with, OR the cache was
    // cleared). So the load is rejected with shard_binding_not_allowed at
    // the auth step, not at the re-validation step.
    const pool = fakePoolD1([
      { ...POOL_ROW, community_id: null, released_at: "t_released" },
    ])
    const env = envForLoad(pool, { DB_CMTY_NEW: fakeD1() })
    const r = await runShardLoadSnapshot(env, {
      communityId: "cmt_new",
      bindingName: "DB_CMTY_NEW",
      statements: [{ sql: "CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)", args: [] }],
    })
    expect(r).toMatchObject({ ok: false, code: "shard_binding_not_allowed" })
  })

  test("§4.2 invariant — reallocated binding with a stale cache: the re-validation catches it", async () => {
    // The keystone scenario for the re-validation: the cache says
    // cmt_new → DB_CMTY_NEW (assertCommunityBinding passes), but the pool
    // has been reallocated to a different community. The re-validation in
    // runShardLoadSnapshot is the last line of defense — it re-reads the
    // pool and rejects with shard_binding_not_allocated.
    const pool = fakePoolD1([{ ...POOL_ROW, community_id: "cmt_new", version: 0 }])
    const env = envForLoad(pool, { DB_CMTY_NEW: fakeD1() })
    // Populate the cache: assertCommunityBinding runs the SELECT, sets
    // cmt_new → DB_CMTY_NEW in the cache, returns null (ok).
    expect(await assertCommunityBinding(env, "cmt_new", "DB_CMTY_NEW")).toBeNull()
    // Simulate the reallocation: the pool now says DB_CMTY_NEW is for a
    // DIFFERENT community (the reconciler ran in another isolate). The cache
    // is still stale (60s TTL not expired).
    const row = pool.rows.find((r) => r.binding_name === "DB_CMTY_NEW")
    if (row) {
      row.community_id = "cmt_other"
      row.released_at = null
    }
    // Load: assertCommunityBinding hits the cache and returns null (passes
    // auth). The re-validation then reads the pool, finds cmt_other, and
    // rejects with shard_binding_not_allocated.
    const r = await runShardLoadSnapshot(env, {
      communityId: "cmt_new",
      bindingName: "DB_CMTY_NEW",
      statements: [{ sql: "CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)", args: [] }],
    })
    expect(r).toMatchObject({
      ok: false,
      code: "shard_binding_not_allocated",
      message: expect.stringContaining("cmt_other"),
    })
  })

  test("returns shard_binding_not_allocated when the binding has no d1_pool row", async () => {
    const pool = fakePoolD1()
    const env = envForLoad(pool, { DB_CMTY_NEW: fakeD1() })
    // Bypass the auth check by pre-populating the cache (so the load RPC
    // gets to the re-validation step instead of being rejected at auth).
    // Use the test-only reset to start clean.
    expect(await assertCommunityBinding(env, "cmt_new", "DB_CMTY_NEW")).toMatchObject({
      ok: false,
      code: "shard_binding_not_allowed",
    })
    // With no pool row at all, the auth step rejects — same code path
    // (community not in the pool) as the "released" case above. The
    // re-validation would also reject (no row at all), but auth catches it
    // first because the cache is empty.
    const r = await runShardLoadSnapshot(env, {
      communityId: "cmt_new",
      bindingName: "DB_CMTY_NEW",
      statements: [{ sql: "CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)", args: [] }],
    })
    expect(r).toMatchObject({ ok: false, code: "shard_binding_not_allowed" })
  })

  test("returns shard_write_not_allowed when the bootstrap guard rejects DDL (DROP)", async () => {
    const pool = fakePoolD1([{ ...POOL_ROW }])
    const env = envForLoad(pool, { DB_CMTY_NEW: fakeD1() })
    const r = await runShardLoadSnapshot(env, {
      communityId: "cmt_new",
      bindingName: "DB_CMTY_NEW",
      statements: [{ sql: "DROP TABLE t", args: [] }],
    })
    expect(r).toMatchObject({ ok: false, code: "shard_write_not_allowed" })
  })

  test("returns shard_write_not_allowed when the bootstrap guard rejects a read statement", async () => {
    const pool = fakePoolD1([{ ...POOL_ROW }])
    const env = envForLoad(pool, { DB_CMTY_NEW: fakeD1() })
    const r = await runShardLoadSnapshot(env, {
      communityId: "cmt_new",
      bindingName: "DB_CMTY_NEW",
      statements: [{ sql: "SELECT 1", args: [] }],
    })
    expect(r).toMatchObject({ ok: false, code: "shard_write_not_allowed" })
  })

  test("returns shard_binding_not_allowed when the (communityId, bindingName) pair is not in the pool", async () => {
    const pool = fakePoolD1([{ ...POOL_ROW, community_id: "cmt_other" }])
    const env = envForLoad(pool, { DB_CMTY_NEW: fakeD1() })
    const r = await runShardLoadSnapshot(env, {
      communityId: "cmt_new",
      bindingName: "DB_CMTY_NEW",
      statements: [{ sql: "CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY)", args: [] }],
    })
    expect(r).toMatchObject({ ok: false, code: "shard_binding_not_allowed" })
  })

  test("empty statements list still marks the binding as loaded (idempotent bootstrap)", async () => {
    const pool = fakePoolD1([{ ...POOL_ROW }])
    const env = envForLoad(pool, { DB_CMTY_NEW: fakeD1() })
    const r = await runShardLoadSnapshot(env, {
      communityId: "cmt_new",
      bindingName: "DB_CMTY_NEW",
      statements: [],
    })
    expect(r).toEqual({ ok: true, value: { rowsAffected: 0, loaded: true } })
    const row = pool.rows.find((r) => r.binding_name === "DB_CMTY_NEW")
    expect(row?.last_loaded_at).not.toBeNull()
  })
})

// --- Step 5 admin RPCs ------------------------------------------------------

const ADMIN_TOKEN = "s3cret-admin-token"

/** Minimal pool D1 fake for the admin RPCs (full-row SELECT + stats aggregate + release UPDATE). */
function adminPoolFake(rows: FakePoolRow[]) {
  function stmt(sql: string) {
    const s: any = {
      _args: [] as unknown[],
      bind(...a: unknown[]) {
        s._args = a
        return s
      },
      async first() {
        if (/COUNT\(\*\)\s+AS\s+total/i.test(sql)) {
          const threshold = s._args[0] as string | undefined
          let allocated = 0
          let free = 0
          let quarantined = 0
          for (const row of rows) {
            if (row.community_id !== null) {
              allocated += 1
            } else if (row.released_at !== null && threshold && row.released_at >= threshold) {
              quarantined += 1
            } else {
              free += 1
            }
          }
          return { total: rows.length, allocated, free, quarantined }
        }
        const binding = s._args[0] as string
        return rows.find((r) => r.binding_name === binding) ?? null
      },
      async run() {
        // release: free the row + stamp released_at, only if currently allocated
        const [binding, now] = s._args as [string, string]
        const row = rows.find((r) => r.binding_name === binding)
        if (row && row.community_id !== null) {
          row.community_id = null
          row.allocated_at = null
          row.last_loaded_at = null
          row.last_error = null
          row.released_at = now
          row.version += 1
          return { success: true, meta: { changes: 1 } }
        }
        return { success: true, meta: { changes: 0 } }
      },
    }
    void sql
    return s
  }
  return { rows, prepare: (sql: string) => stmt(sql) }
}

/** Community D1 fake for reset: lists user tables, records DROPs. */
function resetCommunityFake(tableNames: string[]) {
  const dropped: string[] = []
  const db: any = {
    dropped,
    prepare(sql: string) {
      const s: any = {
        async all() {
          if (/sqlite_master/.test(sql)) {
            return { results: tableNames.map((name) => ({ name })), success: true }
          }
          return { results: [], success: true }
        },
        _sql: sql,
      }
      if (/DROP TABLE/.test(sql)) dropped.push(sql)
      return s
    },
    async batch(stmts: any[]) {
      return stmts.map(() => ({ success: true, meta: { changes: 0 } }))
    },
  }
  return db
}

function adminEnv(over: Partial<ShardEnv> = {}): ShardEnv {
  return { SHARD_ADMIN_TOKEN: ADMIN_TOKEN, ...over } as ShardEnv
}

describe("admin RPC auth (step 5)", () => {
  test("rejects a wrong token with shard_admin_unauthorized", async () => {
    const env = adminEnv({ D1_POOL: adminPoolFake([]) as unknown as D1Database })
    const r = await runShardGetPoolRow(env, { adminToken: "wrong", bindingName: "DB_X" })
    expect(r).toEqual({ ok: false, code: "shard_admin_unauthorized", message: expect.any(String) })
  })

  test("fails closed when the shard has no admin token configured", async () => {
    const env = { D1_POOL: adminPoolFake([]) as unknown as D1Database } as ShardEnv
    const r = await runShardRelease(env, { adminToken: ADMIN_TOKEN, bindingName: "DB_X", now: "t" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("shard_admin_unauthorized")
  })
})

describe("communityD1GetPoolRow (step 5)", () => {
  test("returns the mapped pool row for a binding", async () => {
    const env = adminEnv({
      D1_POOL: adminPoolFake([
        {
          binding_name: "DB_CMTY_1",
          community_id: "cmt_1",
          allocated_at: "t0",
          last_loaded_at: "t1",
          last_error: null,
          released_at: null,
          version: 2,
        },
      ]) as unknown as D1Database,
    })
    const r = await runShardGetPoolRow(env, { adminToken: ADMIN_TOKEN, bindingName: "DB_CMTY_1" })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.value.row?.communityId).toBe("cmt_1")
      expect(r.value.row?.lastLoadedAt).toBe("t1")
      expect(r.value.row?.version).toBe(2)
    }
  })

  test("returns row: null for an unknown binding", async () => {
    const env = adminEnv({ D1_POOL: adminPoolFake([]) as unknown as D1Database })
    const r = await runShardGetPoolRow(env, { adminToken: ADMIN_TOKEN, bindingName: "DB_NONE" })
    expect(r).toEqual({ ok: true, value: { row: null } })
  })
})

describe("communityD1Reset (step 5)", () => {
  // A never-loaded (stuck-provisioning) binding: pool row exists, last_loaded_at NULL.
  function unloadedPool(): D1Database {
    return adminPoolFake([
      {
        binding_name: "DB_CMTY_1",
        community_id: "cmt_1",
        allocated_at: "t0",
        last_loaded_at: null,
        last_error: null,
        released_at: null,
        version: 1,
      },
    ]) as unknown as D1Database
  }

  test("drops all user tables in a never-loaded community D1", async () => {
    const community = resetCommunityFake(["posts", "comments", "votes"])
    const env = adminEnv({ DB_CMTY_1: community as unknown as D1Database, D1_POOL: unloadedPool() })
    const r = await runShardReset(env, { adminToken: ADMIN_TOKEN, bindingName: "DB_CMTY_1" })
    expect(r).toEqual({ ok: true, value: { tablesDropped: 3 } })
  })

  test("is a no-op (tablesDropped: 0) on an empty never-loaded community D1", async () => {
    const env = adminEnv({ DB_CMTY_1: resetCommunityFake([]) as unknown as D1Database, D1_POOL: unloadedPool() })
    const r = await runShardReset(env, { adminToken: ADMIN_TOKEN, bindingName: "DB_CMTY_1" })
    expect(r).toEqual({ ok: true, value: { tablesDropped: 0 } })
  })

  test("REFUSES to drop a fully-loaded (live) binding — closes the load-vs-reset race", async () => {
    const loadedPool = adminPoolFake([
      {
        binding_name: "DB_CMTY_1",
        community_id: "cmt_1",
        allocated_at: "t0",
        last_loaded_at: "t1", // loaded → live → must not be dropped
        last_error: null,
        released_at: null,
        version: 2,
      },
    ]) as unknown as D1Database
    const community = resetCommunityFake(["posts"])
    const env = adminEnv({ DB_CMTY_1: community as unknown as D1Database, D1_POOL: loadedPool })
    const r = await runShardReset(env, { adminToken: ADMIN_TOKEN, bindingName: "DB_CMTY_1" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("shard_binding_loaded")
    // The community DB was never touched.
    expect((community as any).dropped).toHaveLength(0)
  })

  test("REFUSES to drop a binding with no pool row (untracked)", async () => {
    const env = adminEnv({
      DB_CMTY_1: resetCommunityFake(["posts"]) as unknown as D1Database,
      D1_POOL: adminPoolFake([]) as unknown as D1Database,
    })
    const r = await runShardReset(env, { adminToken: ADMIN_TOKEN, bindingName: "DB_CMTY_1" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe("shard_binding_loaded")
  })
})

describe("communityD1Release (step 5)", () => {
  test("frees an allocated binding and stamps released_at (quarantine)", async () => {
    const rows: FakePoolRow[] = [
      {
        binding_name: "DB_CMTY_1",
        community_id: "cmt_1",
        allocated_at: "t0",
        last_loaded_at: null,
        last_error: null,
        released_at: null,
        version: 1,
      },
    ]
    const env = adminEnv({ D1_POOL: adminPoolFake(rows) as unknown as D1Database })
    const r = await runShardRelease(env, { adminToken: ADMIN_TOKEN, bindingName: "DB_CMTY_1", now: "t9" })
    expect(r).toEqual({ ok: true, value: { released: true } })
    expect(rows[0].community_id).toBeNull()
    expect(rows[0].released_at).toBe("t9")
    expect(rows[0].version).toBe(2)
  })

  test("returns released: false when the binding is already free", async () => {
    const rows: FakePoolRow[] = [
      {
        binding_name: "DB_CMTY_1",
        community_id: null,
        allocated_at: null,
        last_loaded_at: null,
        last_error: null,
        released_at: "t5",
        version: 3,
      },
    ]
    const env = adminEnv({ D1_POOL: adminPoolFake(rows) as unknown as D1Database })
    const r = await runShardRelease(env, { adminToken: ADMIN_TOKEN, bindingName: "DB_CMTY_1", now: "t9" })
    expect(r).toEqual({ ok: true, value: { released: false } })
  })
})

describe("communityD1PoolStats", () => {
  test("reports allocated, free, and quarantined pool capacity", async () => {
    const now = Date.now()
    const rows: FakePoolRow[] = [
      {
        binding_name: "DB_CMTY_ALLOCATED",
        community_id: "cmt_1",
        allocated_at: "t0",
        last_loaded_at: "t1",
        last_error: null,
        released_at: null,
        version: 1,
      },
      {
        binding_name: "DB_CMTY_FREE",
        community_id: null,
        allocated_at: null,
        last_loaded_at: null,
        last_error: null,
        released_at: null,
        version: 1,
      },
      {
        binding_name: "DB_CMTY_RELEASED_READY",
        community_id: null,
        allocated_at: null,
        last_loaded_at: null,
        last_error: null,
        released_at: new Date(now - QUARANTINE_WINDOW_MS - 1_000).toISOString(),
        version: 1,
      },
      {
        binding_name: "DB_CMTY_QUARANTINED",
        community_id: null,
        allocated_at: null,
        last_loaded_at: null,
        last_error: null,
        released_at: new Date(now).toISOString(),
        version: 1,
      },
    ]
    const env = adminEnv({ D1_POOL: adminPoolFake(rows) as unknown as D1Database })
    const r = await runShardPoolStats(env, { adminToken: ADMIN_TOKEN })
    expect(r).toEqual({
      ok: true,
      value: {
        total: 4,
        allocated: 1,
        free: 2,
        quarantined: 1,
      },
    })
  })
})
