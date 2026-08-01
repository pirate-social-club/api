import { describe, expect, test } from "bun:test"
import { markPostDeleted, markPostPublished } from "./community-post-mutation-store"
import type { DbExecutor } from "../db-helpers"

/**
 * Buffer-safety regression: inside a buffered D1 write transaction, a read of a
 * just-written row returns nothing until commit. markPostDeleted must therefore
 * be WRITE-ONLY (no in-tx getPostById readback). This fake executor returns empty
 * rows for every statement (as a buffered tx would) and records the leading verbs.
 */
function recordingExecutor() {
  const verbs: string[] = []
  const executor: DbExecutor = {
    execute: async (statement: Parameters<DbExecutor["execute"]>[0]) => {
      const sql = typeof statement === "string" ? statement : statement.sql
      verbs.push(sql.trim().split(/\s+/)[0]?.toUpperCase() ?? "")
      return { rows: [] }
    },
  }
  return { executor, verbs }
}

describe("markPostDeleted (buffer-safe write)", () => {
  test("issues only the UPDATE — no in-tx readback that a buffered D1 tx would lose", async () => {
    const { executor, verbs } = recordingExecutor()
    await markPostDeleted({ executor, postId: "pst_1", now: "t0" })
    // Old code did UPDATE then getPostById (SELECT) and threw on the empty read.
    expect(verbs).toEqual(["UPDATE"])
  })
})

describe("markPostPublished (pre-1148 compatibility)", () => {
  test("does not write age-gate provenance columns when the shard lacks them", async () => {
    const statements: string[] = []
    const executor: DbExecutor = {
      execute: async (statement: Parameters<DbExecutor["execute"]>[0]) => {
        const sql = typeof statement === "string" ? statement : statement.sql
        statements.push(sql)
        return { rows: [] }
      },
    }

    await expect(markPostPublished({
      executor,
      postId: "pst_old_schema",
      analysisState: "allow",
      contentSafetyState: "adult",
      ageGatePolicy: "18_plus",
      now: "2026-08-01T00:00:00.000Z",
    })).rejects.toThrow("Post row is missing after publish update")

    const writeSql = statements
      .filter((sql) => /^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(sql))
      .join("\n")
    expect(writeSql).not.toMatch(/\bage_gate_(?:source|evidence_ref|set_at)\b/u)
  })
})
