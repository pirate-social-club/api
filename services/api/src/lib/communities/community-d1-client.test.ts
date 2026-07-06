import { describe, expect, test } from "bun:test"
import { makeCommunityD1Client } from "./community-d1-client"
import type { ResolvedCommunityBinding } from "./community-binding-resolver"
import { HttpError } from "../errors"

function fakeShard() {
  const calls: Array<{ m: string; input: any }> = []
  return {
    calls,
    execute: async (input: any) => {
      calls.push({ m: "execute", input })
      return { ok: true as const, value: { rows: [{ read: 1 }] } }
    },
    batch: async (input: any) => {
      calls.push({ m: "batch", input })
      return { ok: true as const, value: input.statements.map(() => ({ rows: [] })) }
    },
    batchWrite: async (input: any) => {
      calls.push({ m: "batchWrite", input })
      return {
        ok: true as const,
        value: input.statements.map(() => ({ rows: [], rowsAffected: 1 })),
      }
    },
    communityD1Bind: async (input: any) => {
      calls.push({ m: "communityD1Bind", input })
      return {
        ok: true as const,
        value: { bindingName: "DB_CMTY_NEW", shardWorkerId: "shard-1", allocated: true },
      }
    },
    communityD1LoadSnapshot: async (input: any) => {
      calls.push({ m: "communityD1LoadSnapshot", input })
      return { ok: true as const, value: { rowsAffected: input.statements.length, loaded: true } }
    },
    communityD1GetPoolRow: async (input: any) => {
      calls.push({ m: "communityD1GetPoolRow", input })
      return { ok: true as const, value: { row: null } }
    },
    communityD1Reset: async (input: any) => {
      calls.push({ m: "communityD1Reset", input })
      return { ok: true as const, value: { tablesDropped: 0 } }
    },
    communityD1Release: async (input: any) => {
      calls.push({ m: "communityD1Release", input })
      return { ok: true as const, value: { released: true } }
    },
    communityD1PoolStats: async (input: any) => {
      calls.push({ m: "communityD1PoolStats", input })
      return { ok: true as const, value: { total: 1, allocated: 0, free: 1, quarantined: 0 } }
    },
  }
}

const BINDING = {
  communityId: "cmt_1",
  backend: "d1",
  provisioningState: "ready",
  shardWorkerId: "shard-1",
  bindingName: "DB_CMTY_PILOT",
  region: "enam",
  decommissionedAt: null,
} as ResolvedCommunityBinding

describe("makeCommunityD1Client", () => {
  test("read execute → shard.execute", async () => {
    const shard = fakeShard()
    const c = makeCommunityD1Client(shard, BINDING)
    const r = await c.execute("SELECT id FROM t")
    expect(r.rows).toEqual([{ read: 1 }])
    expect(shard.calls).toEqual([{ m: "execute", input: { communityId: "cmt_1", bindingName: "DB_CMTY_PILOT", statement: "SELECT id FROM t" } }])
  })

  test("write execute → shard.batchWrite([stmt]) returning first result", async () => {
    const shard = fakeShard()
    const c = makeCommunityD1Client(shard, BINDING)
    const r = await c.execute({ sql: "INSERT INTO t (id) VALUES (?1)", args: ["a"] })
    expect(r.rowsAffected).toBe(1)
    expect(shard.calls[0].m).toBe("batchWrite")
    expect(shard.calls[0].input.statements).toEqual([{ sql: "INSERT INTO t (id) VALUES (?1)", args: ["a"] }])
  })

  test("batch read mode → shard.batch; write mode → shard.batchWrite", async () => {
    const shard = fakeShard()
    const c = makeCommunityD1Client(shard, BINDING)
    await c.batch([{ sql: "SELECT 1" }], "read")
    await c.batch([{ sql: "UPDATE t SET n=1" }], "write")
    expect(shard.calls.map((x) => x.m)).toEqual(["batch", "batchWrite"])
  })

  test("write transaction buffers executes and commits them as ONE batchWrite", async () => {
    const shard = fakeShard()
    const c = makeCommunityD1Client(shard, BINDING)
    const tx = await c.transaction("write")
    const r1 = await tx.execute({ sql: "INSERT INTO a (id) VALUES (?1)", args: ["x"] })
    const r2 = await tx.execute({ sql: "INSERT INTO b (id) VALUES (?1)", args: ["y"] })
    // buffered → empty results until commit; nothing sent yet
    expect(r1.rows).toEqual([])
    expect(r2.rows).toEqual([])
    expect(shard.calls).toHaveLength(0)

    await tx.commit()
    expect(shard.calls).toHaveLength(1)
    expect(shard.calls[0].m).toBe("batchWrite")
    expect(shard.calls[0].input.statements).toEqual([
      { sql: "INSERT INTO a (id) VALUES (?1)", args: ["x"] },
      { sql: "INSERT INTO b (id) VALUES (?1)", args: ["y"] },
    ])
  })

  test("rollback drops the buffer — nothing hits the shard", async () => {
    const shard = fakeShard()
    const c = makeCommunityD1Client(shard, BINDING)
    const tx = await c.transaction("write")
    await tx.execute("UPDATE t SET n = 1")
    await tx.rollback()
    expect(shard.calls).toHaveLength(0)
  })

  test("empty write transaction commit is a no-op", async () => {
    const shard = fakeShard()
    const c = makeCommunityD1Client(shard, BINDING)
    const tx = await c.transaction("write")
    await tx.commit()
    expect(shard.calls).toHaveLength(0)
  })

  test("using a finalized transaction throws", async () => {
    const shard = fakeShard()
    const c = makeCommunityD1Client(shard, BINDING)
    const tx = await c.transaction("write")
    await tx.commit()
    await expect(tx.execute("INSERT INTO t VALUES (1)")).rejects.toBeInstanceOf(HttpError)
  })

  test("throws if the d1 binding row has no binding_name", () => {
    const shard = fakeShard()
    expect(() => makeCommunityD1Client(shard, { ...BINDING, bindingName: null } as ResolvedCommunityBinding)).toThrow(HttpError)
  })
})
