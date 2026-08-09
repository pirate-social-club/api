import { describe, expect, test } from "bun:test"
import { shardBlockReason } from "./account-merge-service"
import type { Client } from "../sql-client"

function clientWithMatches(matches: string[]) {
  const statements: string[] = []
  const client = {
    async execute(statement: { sql: string }) {
      statements.push(statement.sql)
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
})
