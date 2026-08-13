import { expect, test } from "bun:test"
import type { DbExecutor } from "../db-helpers"
import { moderationServiceTestOnly } from "./moderation-service"

test("restoring a review-held post preserves approval bookkeeping", async () => {
  const statements: Array<{ sql: string; args?: unknown[] }> = []
  const executor: DbExecutor = {
    execute: async (statement) => {
      const normalized = typeof statement === "string" ? { sql: statement } : statement
      statements.push(normalized)
      return { rows: [], rowsAffected: 1 }
    },
  }

  await moderationServiceTestOnly.applyPostStatusTransition({
    executor,
    postId: "pst_file",
    previousStatus: "draft",
    analysisState: "review_required",
    nextStatus: "published",
    now: "2026-08-13T00:00:00.000Z",
  })

  expect(statements).toHaveLength(1)
  expect(statements[0]?.sql).toContain("analysis_state = 'allow'")
  expect(statements[0]?.sql).toContain("content_safety_state = CASE")
  expect(statements[0]?.args).toEqual(["pst_file", "2026-08-13T00:00:00.000Z"])
})
