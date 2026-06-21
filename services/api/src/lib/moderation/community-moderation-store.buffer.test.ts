import { describe, expect, test } from "bun:test"
import {
  createModerationAction,
  createModerationCase,
  createModerationSignal,
  createUserReport,
} from "./community-moderation-store"
import type { ModerationCase } from "./moderation-types"
import type { DbExecutor } from "../db-helpers"

/**
 * Buffer-safety regressions for the moderation create helpers. Each used to INSERT
 * then SELECT the row back, which breaks inside a buffered D1 write tx (the readback
 * sees nothing until commit). They now return deterministic projections of the
 * inserted columns and must issue ONLY writes. These tests fail if a readback returns.
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
  sqls.some((s) => /^\s*select\b/i.test(s)) || sqls.some((s) => /pragma/i.test(s))

const CASE: ModerationCase = {
  moderation_case_id: "mca_1",
  community_id: "cmt_m",
  post_id: "pst_1",
  comment_id: null,
  status: "open",
  queue_scope: "community",
  priority: "medium",
  opened_by: "user_report",
  created_at: "2026-06-10T00:00:00.000Z",
  updated_at: "2026-06-10T00:00:00.000Z",
  resolved_at: null,
}

describe("moderation create helpers (buffer-safe)", () => {
  test("createModerationCase: INSERT-only, deterministic row", async () => {
    const { executor, sqls } = recordingExecutor()
    const created = await createModerationCase({
      executor,
      communityId: "cmt_m",
      target: { postId: "pst_1" },
      priority: "high",
      openedBy: "user_report",
      now: "2026-06-17T00:00:00.000Z",
    })

    expect(hasRead(sqls)).toBe(false)
    expect(sqls.some((s) => /insert\s+into\s+moderation_cases/i.test(s))).toBe(true)
    expect(created.moderation_case_id).toMatch(/^mca_/)
    expect(created).toMatchObject({
      community_id: "cmt_m",
      post_id: "pst_1",
      comment_id: null,
      status: "open",
      queue_scope: "community",
      priority: "high",
      opened_by: "user_report",
      created_at: "2026-06-17T00:00:00.000Z",
      updated_at: "2026-06-17T00:00:00.000Z",
      resolved_at: null,
    })
  })

  test("createUserReport: INSERT-only, deterministic row", async () => {
    const { executor, sqls } = recordingExecutor()
    const created = await createUserReport({
      executor,
      communityId: "cmt_m",
      moderationCaseId: "mca_1",
      reporterUserId: "usr_r",
      target: { commentId: "cmt_x" },
      body: { reason_code: "spam", note: " hi " },
      now: "2026-06-17T00:00:00.000Z",
    })

    expect(hasRead(sqls)).toBe(false)
    expect(sqls.some((s) => /insert\s+into\s+user_reports/i.test(s))).toBe(true)
    expect(created).toMatchObject({
      community_id: "cmt_m",
      post_id: null,
      comment_id: "cmt_x",
      reporter_user_id: "usr_r",
      reason_code: "spam",
      note: "hi",
      created_at: "2026-06-17T00:00:00.000Z",
    })
    expect(created.user_report_id).toMatch(/^urp_/)
  })

  test("createModerationSignal: INSERT-only, deterministic row", async () => {
    const { executor, sqls } = recordingExecutor()
    const created = await createModerationSignal({
      executor,
      communityId: "cmt_m",
      postId: "pst_1",
      moderationCaseId: "mca_1",
      signalType: "harassment",
      severity: "high",
      provider: "openai",
      providerLabel: "harassment",
      analysisResultRef: null,
      evidenceRef: null,
      now: "2026-06-17T00:00:00.000Z",
    })

    expect(hasRead(sqls)).toBe(false)
    expect(sqls.some((s) => /insert\s+into\s+moderation_signals/i.test(s))).toBe(true)
    expect(created).toMatchObject({
      community_id: "cmt_m",
      post_id: "pst_1",
      comment_id: null,
      source: "platform_analysis",
      signal_type: "harassment",
      severity: "high",
      provider: "openai",
    })
  })

  test("createModerationAction: INSERT-only, deterministic row", async () => {
    const { executor, sqls } = recordingExecutor()
    const created = await createModerationAction({
      executor,
      moderationCase: CASE,
      actorUserId: "usr_mod",
      body: { action_type: "hide", note: null },
      now: "2026-06-17T00:00:00.000Z",
    })

    expect(hasRead(sqls)).toBe(false)
    expect(sqls.some((s) => /insert\s+into\s+moderation_actions/i.test(s))).toBe(true)
    expect(created).toMatchObject({
      moderation_case_id: "mca_1",
      community_id: "cmt_m",
      post_id: "pst_1",
      comment_id: null,
      actor_user_id: "usr_mod",
      action_type: "hide",
      created_at: "2026-06-17T00:00:00.000Z",
    })
    expect(created.moderation_action_id).toMatch(/^mac_/)
  })
})
