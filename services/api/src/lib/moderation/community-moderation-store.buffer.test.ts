import { describe, expect, test } from "bun:test"
import {
  createModerationAction,
  createModerationCase,
  createModerationSignal,
  createUserReport,
  listModerationActionsForCase,
  setAssetModerationEnforcement,
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

  test("generic asset action records paired audit state and enforcement write", async () => {
    const { executor, sqls } = recordingExecutor()
    const created = await createModerationAction({
      executor,
      moderationCase: CASE,
      actorUserId: "usr_mod",
      body: { action_type: "quarantine_asset", evidence_ref: "scan:evt_1" },
      now: "2026-08-13T00:00:00.000Z",
      previousStatus: "published",
      nextStatus: "hidden",
      assetId: "ast_1",
      previousAssetEnforcementState: "active",
      nextAssetEnforcementState: "quarantined",
      evidenceRef: "scan:evt_1",
    })
    await setAssetModerationEnforcement({
      executor,
      assetId: "ast_1",
      moderationActionId: created.moderation_action_id,
      enforcementState: "quarantined",
      reasonCode: "quarantine_asset",
      evidenceRef: "scan:evt_1",
      now: "2026-08-13T00:00:00.000Z",
    })

    expect(hasRead(sqls)).toBe(false)
    expect(sqls.some((s) => /insert\s+into\s+moderation_actions/i.test(s))).toBe(true)
    expect(sqls.some((s) => /update\s+asset_enforcement/i.test(s))).toBe(true)
    expect(created).toMatchObject({
      asset_id: "ast_1",
      previous_post_status: "published",
      next_post_status: "hidden",
      previous_asset_enforcement_state: "active",
      next_asset_enforcement_state: "quarantined",
      evidence_ref: "scan:evt_1",
    })
  })

  test("moderation action reads fall back before generic asset columns exist", async () => {
    const sqls: string[] = []
    const executor: DbExecutor = {
      execute: async (statement) => {
        const sql = typeof statement === "string" ? statement : statement.sql
        sqls.push(sql)
        if (sqls.length === 1) throw new Error("no such column: asset_id")
        return {
          rows: [{
            moderation_action_id: "mac_legacy",
            moderation_case_id: "mca_1",
            community_id: "cmt_m",
            post_id: "pst_1",
            comment_id: null,
            actor_user_id: "usr_mod",
            action_type: "hide",
            note: null,
            created_at: "2026-08-13T00:00:00.000Z",
            previous_post_status: "published",
            next_post_status: "hidden",
            previous_content_safety_state: null,
            next_content_safety_state: null,
            previous_age_gate_policy: null,
            next_age_gate_policy: null,
            evidence_ref: null,
          }],
        }
      },
    }

    const actions = await listModerationActionsForCase({ executor, moderationCaseId: "mca_1" })
    expect(sqls).toHaveLength(2)
    expect(actions[0]).toMatchObject({
      moderation_action_id: "mac_legacy",
      asset_id: null,
      previous_post_status: "published",
      next_post_status: "hidden",
    })
  })
})
