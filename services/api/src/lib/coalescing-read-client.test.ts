import { describe, expect, test } from "bun:test"

import type { InStatement, QueryResult, ReadClient } from "./sql-client"
import { createCoalescingReadClient } from "./coalescing-read-client"

describe("createCoalescingReadClient", () => {
  test("runs independent reads queued together as one ordered batch", async () => {
    const batches: InStatement[][] = []
    const client: ReadClient = {
      execute: async () => {
        throw new Error("execute should not be called")
      },
      batch: async (statements) => {
        batches.push(statements)
        return statements.map((statement, index) => ({
          rows: [{ sql: statement.sql, index }],
        }))
      },
    }
    const coalesced = createCoalescingReadClient(client)

    const [first, second, third] = await Promise.all([
      coalesced.execute("SELECT 1"),
      coalesced.execute({ sql: "SELECT ?1", args: [2] }),
      coalesced.execute("SELECT 3"),
    ])

    expect(batches).toEqual([[
      { sql: "SELECT 1" },
      { sql: "SELECT ?1", args: [2] },
      { sql: "SELECT 3" },
    ]])
    expect(first.rows[0]).toEqual({ sql: "SELECT 1", index: 0 })
    expect(second.rows[0]).toEqual({ sql: "SELECT ?1", index: 1 })
    expect(third.rows[0]).toEqual({ sql: "SELECT 3", index: 2 })
  })

  test("forms another batch for a read that depends on the first result", async () => {
    const batches: InStatement[][] = []
    const client: ReadClient = {
      execute: async () => ({ rows: [] }),
      batch: async (statements) => {
        batches.push(statements)
        return statements.map((): QueryResult => ({ rows: [{ value: batches.length }] }))
      },
    }
    const coalesced = createCoalescingReadClient(client)

    const first = await coalesced.execute("SELECT 1")
    const second = await coalesced.execute({ sql: "SELECT ?1", args: [first.rows[0]?.value] })

    expect(batches).toEqual([
      [{ sql: "SELECT 1" }],
      [{ sql: "SELECT ?1", args: [1] }],
    ])
    expect(second.rows[0]?.value).toBe(2)
  })

  test("rejects every queued read when the underlying batch fails", async () => {
    const failure = new Error("batch unavailable")
    const client: ReadClient = {
      execute: async () => ({ rows: [] }),
      batch: async () => {
        throw failure
      },
    }
    const coalesced = createCoalescingReadClient(client)

    const results = await Promise.allSettled([
      coalesced.execute("SELECT 1"),
      coalesced.execute("SELECT 2"),
    ])

    expect(results).toEqual([
      { status: "rejected", reason: failure },
      { status: "rejected", reason: failure },
    ])
  })
})
