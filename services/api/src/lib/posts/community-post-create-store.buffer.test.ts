import { describe, expect, test } from "bun:test"
import { insertPost } from "./community-post-create-store"
import type { PostProjectionSchema } from "./community-post-projection"
import type { DbExecutor } from "../db-helpers"

/**
 * Buffer-safety regression for insertPost. Inside a buffered D1 write tx, neither
 * a schema inspection (`resolvePostProjectionSchema` → PRAGMA table_info) nor a
 * readback (`getPostById` → SELECT) sees anything until commit. insertPost must
 * therefore issue ONLY writes: the projection schema is passed in (no PRAGMA), and
 * it returns a deterministic draft (no SELECT readback). This test fails if either
 * comes back inside the tx.
 */
const FULL_SCHEMA: PostProjectionSchema = {
  hasAssetStoryColumns: true,
  hasCommentLockColumns: true,
  hasCrosspostSourceJson: true,
  hasPostEvents: true,
  hasRightsHolds: true,
  hasSongAnnotationsUrl: true,
  hasSongCoverArtRef: true,
  hasSongDurationMs: true,
  hasAsyncPublishColumns: true,
}

function recordingExecutor() {
  const sqls: string[] = []
  const executor: DbExecutor = {
    execute: async (statement: Parameters<DbExecutor["execute"]>[0]) => {
      sqls.push(typeof statement === "string" ? statement : statement.sql)
      return { rows: [] }
    },
  }
  return { executor, sqls }
}

describe("insertPost (buffer-safe)", () => {
  test("issues only writes — no in-tx schema inspection (PRAGMA) or readback (SELECT)", async () => {
    const { executor, sqls } = recordingExecutor()
    const draft = await insertPost({
      client: executor,
      communityId: "cmt_buf",
      authorUserId: "usr_buf",
      body: { post_type: "text", title: "T", body: "B", idempotency_key: "buf-1" },
      createdAt: "2026-06-17T00:00:00.000Z",
      projectionSchema: FULL_SCHEMA,
    })

    // Returned a deterministic draft (not a DB-hydrated row).
    expect(draft.post_id).toMatch(/^pst_/)
    expect(draft.post_type).toBe("text")
    expect(draft.status).toBe("published")

    // No schema inspection and no readback ran against the (buffered) tx executor.
    expect(sqls.some((s) => /pragma/i.test(s))).toBe(false)
    expect(sqls.some((s) => /^\s*select\b/i.test(s))).toBe(false)
    // It did perform the write.
    expect(sqls.some((s) => /insert\s+into\s+posts/i.test(s))).toBe(true)
  })
})
