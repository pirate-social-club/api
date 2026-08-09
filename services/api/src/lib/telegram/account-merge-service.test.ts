import { describe, expect, test } from "bun:test"
import { isReadOnlyStatement } from "@pirate/api-shared"
import { migrateShard, shardBlockReason } from "./account-merge-service"
import type { Client, InStatement } from "../sql-client"

function clientWithMatches(matches: string[], errorFor?: { match: string; error: Error }) {
  const statements: string[] = []
  const client = {
    async execute(statement: { sql: string }) {
      statements.push(statement.sql)
      if (errorFor && statement.sql.includes(errorFor.match)) throw errorFor.error
      return { rows: matches.some((match) => statement.sql.includes(match)) ? [{ present: 1 }] : [] }
    },
  } as unknown as Client
  return { client, statements }
}

describe("Telegram account merge shard preflight", () => {
  test("uses bounded statements instead of a compound select", async () => {
    const { client, statements } = clientWithMatches([])

    expect(await shardBlockReason(client, "source_user")).toBeNull()
    expect(statements).toHaveLength(6)
    expect(statements.every((sql) => !/\bUNION\b/iu.test(sql))).toBe(true)
  })

  test("preserves block-reason precedence while short-circuiting", async () => {
    const authority = clientWithMatches(["FROM communities", "FROM purchases"])
    expect(await shardBlockReason(authority.client, "source_user")).toBe("community_authority")
    expect(authority.statements).toHaveLength(2)

    const authored = clientWithMatches(["FROM comments", "FROM bookings"])
    expect(await shardBlockReason(authored.client, "source_user")).toBe("authored_content")
    expect(authored.statements).toHaveLength(4)
  })

  test("treats an absent legacy bookings table as no booking activity", async () => {
    const legacy = clientWithMatches([], {
      match: "FROM bookings",
      error: new Error("D1_ERROR: no such table: bookings: SQLITE_ERROR"),
    })
    expect(await shardBlockReason(legacy.client, "source_user")).toBeNull()
    expect(legacy.statements).toHaveLength(6)

    const unavailable = clientWithMatches([], {
      match: "FROM bookings",
      error: new Error("D1_ERROR: database unavailable"),
    })
    await expect(shardBlockReason(unavailable.client, "source_user")).rejects.toThrow("database unavailable")
  })
})

test("shard migration plans reads before opening the buffered write transaction", async () => {
  const writes: InStatement[] = []
  const client = {
    async execute() {
      return { rows: [] }
    },
    async transaction() {
      return {
        async execute(statement: InStatement) {
          writes.push(statement)
          return { rows: [] }
        },
        async batch() { return [] },
        async commit() {
          const read = writes.find((statement) => isReadOnlyStatement(statement.sql))
          if (read) throw new Error(`Statement rejected by shard write guard: ${read.sql}`)
        },
        async rollback() {},
        close() {},
      }
    },
  } as unknown as Client

  await migrateShard(client, {
    id: "merge_d1_plan",
    sourceUserId: "source_user",
    canonicalUserId: "canonical_user",
    status: "migrating",
    blockReason: null,
  })
  expect(writes.length).toBeGreaterThan(0)
})
