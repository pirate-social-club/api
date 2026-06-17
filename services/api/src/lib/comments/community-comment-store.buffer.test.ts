import { describe, expect, test } from "bun:test"
import { markCommentDeleted, setCommentStatus, upsertCommentVote } from "./community-comment-store"
import type { DbExecutor } from "../db-helpers"

/**
 * Buffer-safety regressions for the comment write helpers. Inside a buffered D1
 * write tx, a SELECT/PRAGMA sees nothing until commit, so these helpers must issue
 * ONLY writes:
 *  - upsertCommentVote takes the prior vote as a param (no in-tx SELECT) and returns
 *    a deterministic result (no readback).
 *  - markCommentDeleted / setCommentStatus are write-only (return void); the caller
 *    reconstructs the Comment from the pre-tx row.
 * Each test fails if any read leaks back inside the (buffered) tx executor.
 */
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

const hasRead = (sqls: string[]) =>
  sqls.some((s) => /pragma/i.test(s)) || sqls.some((s) => /^\s*select\b/i.test(s))

describe("comment write helpers (buffer-safe)", () => {
  test("upsertCommentVote issues no in-tx read; writes the vote and the count update", async () => {
    const { executor, sqls } = recordingExecutor()
    const result = await upsertCommentVote({
      executor,
      commentId: "cmt_buf",
      userId: "usr_buf",
      value: 1,
      previousValue: -1,
      now: "2026-06-17T00:00:00.000Z",
    })

    expect(result).toEqual({ comment_id: "cmt_buf", value: 1 })
    expect(hasRead(sqls)).toBe(false)
    expect(sqls.some((s) => /insert\s+into\s+comment_votes/i.test(s))).toBe(true)
    expect(sqls.some((s) => /update\s+comments/i.test(s))).toBe(true)
  })

  test("upsertCommentVote skips the count update when the vote is unchanged (no read)", async () => {
    const { executor, sqls } = recordingExecutor()
    await upsertCommentVote({
      executor,
      commentId: "cmt_buf",
      userId: "usr_buf",
      value: 1,
      previousValue: 1,
      now: "2026-06-17T00:00:00.000Z",
    })

    expect(hasRead(sqls)).toBe(false)
    expect(sqls.some((s) => /insert\s+into\s+comment_votes/i.test(s))).toBe(true)
    expect(sqls.some((s) => /update\s+comments/i.test(s))).toBe(false)
  })

  test("markCommentDeleted is write-only — one UPDATE, no read", async () => {
    const { executor, sqls } = recordingExecutor()
    const out = await markCommentDeleted({
      executor,
      commentId: "cmt_buf",
      now: "2026-06-17T00:00:00.000Z",
    })

    expect(out).toBeUndefined()
    expect(hasRead(sqls)).toBe(false)
    expect(sqls.filter((s) => /update\s+comments/i.test(s)).length).toBe(1)
    expect(sqls.some((s) => /status\s*=\s*'deleted'/i.test(s))).toBe(true)
  })

  test("setCommentStatus is write-only — one UPDATE, no read", async () => {
    const { executor, sqls } = recordingExecutor()
    const out = await setCommentStatus({
      executor,
      commentId: "cmt_buf",
      status: "removed",
      now: "2026-06-17T00:00:00.000Z",
    })

    expect(out).toBeUndefined()
    expect(hasRead(sqls)).toBe(false)
    expect(sqls.filter((s) => /update\s+comments/i.test(s)).length).toBe(1)
  })
})
