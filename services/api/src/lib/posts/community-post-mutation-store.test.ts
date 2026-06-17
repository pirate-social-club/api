import { describe, expect, test } from "bun:test"
import { markPostDeleted } from "./community-post-mutation-store"
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
