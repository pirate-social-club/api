import { describe, expect, test } from "bun:test"
import { syncCommunityLabels, type CommunityLabelRow } from "./community-label-store"
import type { DbExecutor } from "../db-helpers"

/**
 * Buffer-safety regression for syncCommunityLabels. It used to read the existing
 * labels itself (a SELECT), which breaks when run inside a buffered D1 write tx —
 * the read sees nothing until commit, so created_at preservation and the
 * archive-removed pass would be wrong. The existing labels are now passed in, so the
 * function must issue ONLY writes. This test fails if any read leaks back.
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

function labelRow(id: string, overrides: Partial<CommunityLabelRow> = {}): CommunityLabelRow {
  return {
    label_id: id,
    community_id: "cmt_l",
    label: id,
    description: null,
    color_token: null,
    status: "active",
    created_at: "2026-06-01T00:00:00.000Z",
    updated_at: "2026-06-01T00:00:00.000Z",
    ...overrides,
  }
}

describe("syncCommunityLabels (buffer-safe)", () => {
  test("issues only writes — no read; upserts incoming and archives removed", async () => {
    const { executor, sqls } = recordingExecutor()
    await syncCommunityLabels({
      executor,
      communityId: "cmt_l",
      // lbl_keep stays, lbl_gone is removed (should be archived), lbl_new is added.
      existingLabels: [labelRow("lbl_keep"), labelRow("lbl_gone")],
      definitions: [
        { label_id: "lbl_keep", label: "Keep", status: "active" },
        { label_id: "lbl_new", label: "New", status: "active" },
      ],
      now: "2026-06-17T00:00:00.000Z",
    })

    // No read of any kind ran against the (buffered) tx executor.
    expect(sqls.some((s) => /^\s*select\b/i.test(s) || /pragma/i.test(s))).toBe(false)
    // Two upserts (lbl_keep, lbl_new).
    expect(sqls.filter((s) => /insert\s+into\s+labels/i.test(s)).length).toBe(2)
    // One archive UPDATE for the removed label.
    expect(sqls.filter((s) => /update\s+labels/i.test(s) && /'archived'/i.test(s)).length).toBe(1)
  })

  test("already-archived removed labels are not re-archived", async () => {
    const { executor, sqls } = recordingExecutor()
    await syncCommunityLabels({
      executor,
      communityId: "cmt_l",
      existingLabels: [labelRow("lbl_old", { status: "archived" })],
      definitions: [],
      now: "2026-06-17T00:00:00.000Z",
    })

    expect(sqls.some((s) => /^\s*select\b/i.test(s))).toBe(false)
    expect(sqls.filter((s) => /update\s+labels/i.test(s)).length).toBe(0)
    expect(sqls.filter((s) => /insert\s+into\s+labels/i.test(s)).length).toBe(0)
  })
})
