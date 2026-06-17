import { describe, expect, test } from "bun:test"
import { resolveD1, runShardBatch, runShardRead, ShardReadError, type D1BindingEnv } from "./shard-read"

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

function envWith(db: unknown): D1BindingEnv {
  return { DB_CMTY_PILOT: db as D1Database } as D1BindingEnv
}

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
      resolveD1({ DB_CMTY_PILOT: notD1 } as D1BindingEnv, "DB_CMTY_PILOT")
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
