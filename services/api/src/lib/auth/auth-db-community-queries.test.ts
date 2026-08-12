import { describe, expect, test } from "bun:test"
import type { DbExecutor } from "../db-helpers"
import { listScheduledCommunityJobPollIds } from "./auth-db-community-queries"

describe("listScheduledCommunityJobPollIds", () => {
  test("keeps only eligible priorities and preserves their requested order", async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = []
    const executor: DbExecutor = {
      async execute(statement) {
        if (typeof statement === "string") throw new Error("Expected a parameterized statement")
        calls.push({ sql: statement.sql, args: [...(statement.args ?? [])] })
        if (calls.length === 1) return { rows: [{ active_count: 3 }] }
        if (calls.length === 2) {
          return { rows: [{ community_id: "cmt_priority_beta" }, { community_id: "cmt_priority_alpha" }] }
        }
        return { rows: [{ community_id: "cmt_oldest" }] }
      },
    }

    const ids = await listScheduledCommunityJobPollIds(executor, {
      maxCommunities: 5,
      priorityCommunityIds: ["cmt_priority_beta", "cmt_ineligible", "cmt_priority_alpha"],
    })

    expect(ids).toEqual(["cmt_priority_beta", "cmt_priority_alpha", "cmt_oldest"])
    expect(calls).toHaveLength(3)
    expect(calls[1]?.args).toEqual(["cmt_priority_beta", "cmt_ineligible", "cmt_priority_alpha"])
    expect(calls[1]?.sql).toContain("ORDER BY CASE c.community_id")
    for (const call of calls) {
      expect(call.sql).toContain("r.provisioning_state = 'ready'")
      expect(call.sql).toContain("r.decommissioned_at IS NULL")
    }
  })

  test("uses bounded newest and rotating queries with wraparound", async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = []
    const executor: DbExecutor = {
      async execute(statement) {
        if (typeof statement === "string") throw new Error("Expected a parameterized statement")
        calls.push({ sql: statement.sql, args: [...(statement.args ?? [])] })
        if (calls.length === 1) return { rows: [{ active_count: 11 }] }
        if (calls.length === 2) return { rows: [{ community_id: "cmt_priority" }] }
        if (calls.length === 3) return { rows: [{ community_id: "cmt_newest" }] }
        if (calls.length === 4) return { rows: [{ community_id: "cmt_old_008" }] }
        return { rows: [{ community_id: "cmt_old_000" }] }
      },
    }

    const ids = await listScheduledCommunityJobPollIds(executor, {
      maxCommunities: 4,
      nowMs: 4 * 60_000,
      priorityCommunityIds: ["cmt_priority"],
    })

    expect(ids).toEqual(["cmt_priority", "cmt_newest", "cmt_old_008", "cmt_old_000"])
    expect(calls).toHaveLength(5)
    expect(calls[2]?.sql).toContain("ORDER BY c.created_at DESC")
    expect(calls[2]?.args).toEqual(["cmt_priority", 1])
    expect(calls[3]?.args).toEqual(["cmt_priority", "cmt_newest", 1, 8])
    expect(calls[4]?.args).toEqual(["cmt_priority", "cmt_newest", "cmt_old_008", 1, 0])
  })

  test("caps an oversized request at one hundred communities", async () => {
    const calls: Array<{ sql: string; args: unknown[] }> = []
    const executor: DbExecutor = {
      async execute(statement) {
        if (typeof statement === "string") throw new Error("Expected a parameterized statement")
        calls.push({ sql: statement.sql, args: [...(statement.args ?? [])] })
        return calls.length === 1 ? { rows: [{ active_count: 2 }] } : { rows: [] }
      },
    }

    await listScheduledCommunityJobPollIds(executor, { maxCommunities: 500 })

    expect(calls[1]?.args).toEqual([100])
  })
})
