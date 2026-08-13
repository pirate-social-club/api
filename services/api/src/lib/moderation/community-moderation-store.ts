import type { DbExecutor } from "../db-helpers"
import { executeFirst } from "../db-helpers"
import { makeId } from "../helpers"
import { requiredString, rowValue, stringOrNull } from "../sql-row"
import type {
  CreateModerationActionRequest,
  CreateUserReportRequest,
  ModerationAction,
  ModerationCase,
  ModerationCaseListItem,
  ModerationCaseOpenedBy,
  ModerationSignal,
  ModerationSignalSeverity,
  UserReport,
} from "./moderation-types"

type TargetRef =
  | { postId: string; commentId?: never }
  | { postId?: never; commentId: string }

function targetArgs(target: TargetRef): [string | null, string | null] {
  return [target.postId ?? null, target.commentId ?? null]
}

function serializeModerationCase(row: unknown): ModerationCase {
  return {
    moderation_case_id: requiredString(row, "moderation_case_id"),
    community_id: requiredString(row, "community_id"),
    post_id: stringOrNull(rowValue(row, "post_id")),
    comment_id: stringOrNull(rowValue(row, "comment_id")),
    status: requiredString(row, "status") as ModerationCase["status"],
    queue_scope: requiredString(row, "queue_scope") as ModerationCase["queue_scope"],
    priority: requiredString(row, "priority") as ModerationCase["priority"],
    opened_by: requiredString(row, "opened_by") as ModerationCase["opened_by"],
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
    resolved_at: stringOrNull(rowValue(row, "resolved_at")),
  }
}

function serializeUserReport(row: unknown): UserReport {
  return {
    user_report_id: requiredString(row, "user_report_id"),
    community_id: requiredString(row, "community_id"),
    post_id: stringOrNull(rowValue(row, "post_id")),
    comment_id: stringOrNull(rowValue(row, "comment_id")),
    reporter_user_id: requiredString(row, "reporter_user_id"),
    reason_code: requiredString(row, "reason_code") as UserReport["reason_code"],
    note: stringOrNull(rowValue(row, "note")),
    created_at: requiredString(row, "created_at"),
  }
}

function serializeModerationSignal(row: unknown): ModerationSignal {
  return {
    moderation_signal_id: requiredString(row, "moderation_signal_id"),
    community_id: requiredString(row, "community_id"),
    post_id: stringOrNull(rowValue(row, "post_id")),
    comment_id: stringOrNull(rowValue(row, "comment_id")),
    analysis_result_ref: stringOrNull(rowValue(row, "analysis_result_ref")),
    source: requiredString(row, "source") as ModerationSignal["source"],
    signal_type: requiredString(row, "signal_type"),
    severity: requiredString(row, "severity") as ModerationSignal["severity"],
    provider: requiredString(row, "provider"),
    provider_label: requiredString(row, "provider_label"),
    evidence_ref: stringOrNull(rowValue(row, "evidence_ref")),
    created_at: requiredString(row, "created_at"),
  }
}

function serializeModerationAction(row: unknown): ModerationAction {
  return {
    moderation_action_id: requiredString(row, "moderation_action_id"),
    moderation_case_id: requiredString(row, "moderation_case_id"),
    community_id: requiredString(row, "community_id"),
    post_id: stringOrNull(rowValue(row, "post_id")),
    comment_id: stringOrNull(rowValue(row, "comment_id")),
    asset_id: stringOrNull(rowValue(row, "asset_id")),
    actor_user_id: requiredString(row, "actor_user_id"),
    action_type: requiredString(row, "action_type") as ModerationAction["action_type"],
    note: stringOrNull(rowValue(row, "note")),
    previous_content_safety_state: stringOrNull(rowValue(row, "previous_content_safety_state")) as ModerationAction["previous_content_safety_state"],
    next_content_safety_state: stringOrNull(rowValue(row, "next_content_safety_state")) as ModerationAction["next_content_safety_state"],
    previous_age_gate_policy: stringOrNull(rowValue(row, "previous_age_gate_policy")) as ModerationAction["previous_age_gate_policy"],
    next_age_gate_policy: stringOrNull(rowValue(row, "next_age_gate_policy")) as ModerationAction["next_age_gate_policy"],
    evidence_ref: stringOrNull(rowValue(row, "evidence_ref")),
    previous_post_status: stringOrNull(rowValue(row, "previous_post_status")) as ModerationAction["previous_post_status"],
    next_post_status: stringOrNull(rowValue(row, "next_post_status")) as ModerationAction["next_post_status"],
    previous_asset_enforcement_state: stringOrNull(rowValue(row, "previous_asset_enforcement_state")) as ModerationAction["previous_asset_enforcement_state"],
    next_asset_enforcement_state: stringOrNull(rowValue(row, "next_asset_enforcement_state")) as ModerationAction["next_asset_enforcement_state"],
    created_at: requiredString(row, "created_at"),
  }
}

export async function createModerationSignal(input: {
  executor: DbExecutor
  communityId: string
  postId: string
  moderationCaseId: string
  signalType: string
  severity: ModerationSignalSeverity
  provider: string
  providerLabel: string
  analysisResultRef: string | null
  evidenceRef: string | null
  now: string
}): Promise<ModerationSignal> {
  const moderationSignalId = makeId("msi")
  await input.executor.execute({
    sql: `
      INSERT INTO moderation_signals (
        moderation_signal_id, community_id, post_id, moderation_case_id,
        analysis_result_ref, source, signal_type, severity,
        provider, provider_label, evidence_ref, created_at
      ) VALUES (
        ?1, ?2, ?3, ?4,
        ?5, 'platform_analysis', ?6, ?7,
        ?8, ?9, ?10, ?11
      )
    `,
    args: [
      moderationSignalId,
      input.communityId,
      input.postId,
      input.moderationCaseId,
      input.analysisResultRef,
      input.signalType,
      input.severity,
      input.provider,
      input.providerLabel,
      input.evidenceRef,
      input.now,
    ],
  })
  // Deterministic projection of the inserted row — buffer-safe (no in-tx readback).
  // This runs inside the post-create write tx via recordReviewRequiredPostModeration.
  return {
    moderation_signal_id: moderationSignalId,
    community_id: input.communityId,
    post_id: input.postId,
    comment_id: null,
    analysis_result_ref: input.analysisResultRef,
    source: "platform_analysis",
    signal_type: input.signalType,
    severity: input.severity,
    provider: input.provider,
    provider_label: input.providerLabel,
    evidence_ref: input.evidenceRef,
    created_at: input.now,
  }
}

export async function getOpenModerationCaseForTarget(input: {
  executor: DbExecutor
  communityId: string
  target: TargetRef
}): Promise<ModerationCase | null> {
  const [postId, commentId] = targetArgs(input.target)
  const row = await executeFirst(input.executor, {
    sql: `
      SELECT moderation_case_id, community_id, post_id, comment_id, status, queue_scope,
             priority, opened_by, created_at, updated_at, resolved_at
      FROM moderation_cases
      WHERE community_id = ?1
        AND COALESCE(post_id, '') = COALESCE(?2, '')
        AND COALESCE(comment_id, '') = COALESCE(?3, '')
        AND status = 'open'
      LIMIT 1
    `,
    args: [input.communityId, postId, commentId],
  })
  return row ? serializeModerationCase(row) : null
}

export async function getModerationCaseById(input: {
  executor: DbExecutor
  moderationCaseId: string
}): Promise<ModerationCase | null> {
  const row = await executeFirst(input.executor, {
    sql: `
      SELECT moderation_case_id, community_id, post_id, comment_id, status, queue_scope,
             priority, opened_by, created_at, updated_at, resolved_at
      FROM moderation_cases
      WHERE moderation_case_id = ?1
      LIMIT 1
    `,
    args: [input.moderationCaseId],
  })
  return row ? serializeModerationCase(row) : null
}

export async function createModerationCase(input: {
  executor: DbExecutor
  communityId: string
  target: TargetRef
  priority: ModerationSignalSeverity
  openedBy: ModerationCaseOpenedBy
  now: string
}): Promise<ModerationCase> {
  const moderationCaseId = makeId("mca")
  const [postId, commentId] = targetArgs(input.target)
  await input.executor.execute({
    sql: `
      INSERT INTO moderation_cases (
        moderation_case_id, community_id, post_id, comment_id, status, queue_scope, priority,
        opened_by, created_at, updated_at, resolved_at
      ) VALUES (
        ?1, ?2, ?3, ?4, 'open', 'community', ?5,
        ?6, ?7, ?7, NULL
      )
    `,
    args: [moderationCaseId, input.communityId, postId, commentId, input.priority, input.openedBy, input.now],
  })
  // Deterministic projection of the inserted row — no readback, so this is safe inside
  // a buffered D1 write tx. Mirrors the INSERT column values exactly.
  return {
    moderation_case_id: moderationCaseId,
    community_id: input.communityId,
    post_id: postId,
    comment_id: commentId,
    status: "open",
    queue_scope: "community",
    priority: input.priority,
    opened_by: input.openedBy,
    created_at: input.now,
    updated_at: input.now,
    resolved_at: null,
  }
}

export async function updateModerationCaseOpenedBy(input: {
  executor: DbExecutor
  moderationCaseId: string
  openedBy: ModerationCaseOpenedBy
  now: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      UPDATE moderation_cases
      SET opened_by = ?2,
          updated_at = ?3
      WHERE moderation_case_id = ?1
    `,
    args: [input.moderationCaseId, input.openedBy, input.now],
  })
}

export async function resolveModerationCase(input: {
  executor: DbExecutor
  moderationCaseId: string
  now: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      UPDATE moderation_cases
      SET status = 'resolved',
          resolved_at = ?2,
          updated_at = ?2
      WHERE moderation_case_id = ?1
    `,
    args: [input.moderationCaseId, input.now],
  })
}

export async function findExistingUserReport(input: {
  executor: DbExecutor
  communityId: string
  reporterUserId: string
  target: TargetRef
}): Promise<UserReport | null> {
  const [postId, commentId] = targetArgs(input.target)
  const row = await executeFirst(input.executor, {
    sql: `
      SELECT user_report_id, community_id, post_id, comment_id, reporter_user_id, reason_code, note, created_at
      FROM user_reports
      WHERE community_id = ?1
        AND reporter_user_id = ?2
        AND COALESCE(post_id, '') = COALESCE(?3, '')
        AND COALESCE(comment_id, '') = COALESCE(?4, '')
      LIMIT 1
    `,
    args: [input.communityId, input.reporterUserId, postId, commentId],
  })
  return row ? serializeUserReport(row) : null
}

export async function createUserReport(input: {
  executor: DbExecutor
  communityId: string
  moderationCaseId: string
  reporterUserId: string
  target: TargetRef
  body: CreateUserReportRequest
  now: string
}): Promise<UserReport> {
  const userReportId = makeId("urp")
  const [postId, commentId] = targetArgs(input.target)
  await input.executor.execute({
    sql: `
      INSERT INTO user_reports (
        user_report_id, community_id, post_id, comment_id, moderation_case_id, reporter_user_id,
        reason_code, note, created_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6,
        ?7, ?8, ?9
      )
    `,
    args: [
      userReportId,
      input.communityId,
      postId,
      commentId,
      input.moderationCaseId,
      input.reporterUserId,
      input.body.reason_code,
      input.body.note?.trim() || null,
      input.now,
    ],
  })
  // Deterministic projection of the inserted row — buffer-safe (no in-tx readback).
  return {
    user_report_id: userReportId,
    community_id: input.communityId,
    post_id: postId,
    comment_id: commentId,
    reporter_user_id: input.reporterUserId,
    reason_code: input.body.reason_code,
    note: input.body.note?.trim() || null,
    created_at: input.now,
  }
}

function serializeModerationCaseListItem(row: unknown): ModerationCaseListItem {
  const caseRow = serializeModerationCase(row)
  const postId = stringOrNull(rowValue(row, "post_id"))
  const postType = stringOrNull(rowValue(row, "post_type"))
  return {
    ...caseRow,
    post: postId && postType
      ? {
          post_id: postId,
          post_type: postType,
          status: requiredString(row, "post_status"),
          title: stringOrNull(rowValue(row, "post_title")),
          body: stringOrNull(rowValue(row, "post_body")),
          caption: stringOrNull(rowValue(row, "post_caption")),
          media_refs_json: stringOrNull(rowValue(row, "media_refs_json")),
          author_handle: stringOrNull(rowValue(row, "author_handle")),
          author_user_id: stringOrNull(rowValue(row, "author_user_id")),
          identity_mode: stringOrNull(rowValue(row, "identity_mode")),
        }
      : null,
  }
}

export async function listModerationCases(input: {
  executor: DbExecutor
  communityId: string
}): Promise<ModerationCaseListItem[]> {
  const result = await input.executor.execute({
    sql: `
      SELECT
        mc.moderation_case_id, mc.community_id, mc.post_id, mc.comment_id, mc.status, mc.queue_scope,
        mc.priority, mc.opened_by, mc.created_at, mc.updated_at, mc.resolved_at,
        p.post_id as post_post_id, p.post_type, p.status as post_status, p.title as post_title,
        p.body as post_body, p.caption as post_caption, p.media_refs_json,
        p.author_user_id, p.identity_mode, NULL as author_handle
      FROM moderation_cases mc
      LEFT JOIN posts p ON p.post_id = mc.post_id
      WHERE mc.community_id = ?1
        AND mc.status = 'open'
      ORDER BY mc.updated_at DESC, mc.moderation_case_id DESC
    `,
    args: [input.communityId],
  })
  return result.rows.map((row) => serializeModerationCaseListItem(row))
}

export async function listModerationSignalsForCase(input: {
  executor: DbExecutor
  moderationCaseId: string
}): Promise<ModerationSignal[]> {
  const result = await input.executor.execute({
    sql: `
      SELECT moderation_signal_id, community_id, post_id, comment_id, analysis_result_ref,
             source, signal_type, severity, provider, provider_label, evidence_ref, created_at
      FROM moderation_signals
      WHERE moderation_case_id = ?1
      ORDER BY created_at ASC, moderation_signal_id ASC
    `,
    args: [input.moderationCaseId],
  })
  return result.rows.map((row) => serializeModerationSignal(row))
}

export async function listUserReportsForCase(input: {
  executor: DbExecutor
  moderationCaseId: string
}): Promise<UserReport[]> {
  const result = await input.executor.execute({
    sql: `
      SELECT user_report_id, community_id, post_id, comment_id, reporter_user_id, reason_code, note, created_at
      FROM user_reports
      WHERE moderation_case_id = ?1
      ORDER BY created_at ASC, user_report_id ASC
    `,
    args: [input.moderationCaseId],
  })
  return result.rows.map((row) => serializeUserReport(row))
}

export async function listModerationActionsForCase(input: {
  executor: DbExecutor
  moderationCaseId: string
}): Promise<ModerationAction[]> {
  let result
  try {
    result = await input.executor.execute({
      sql: `
      SELECT moderation_action_id, moderation_case_id, community_id, post_id, comment_id,
             asset_id, actor_user_id, action_type, note, created_at,
             previous_post_status, next_post_status,
             previous_asset_enforcement_state, next_asset_enforcement_state,
             previous_content_safety_state, next_content_safety_state,
             previous_age_gate_policy, next_age_gate_policy, evidence_ref
      FROM moderation_actions
      WHERE moderation_case_id = ?1
      ORDER BY created_at ASC, moderation_action_id ASC
    `,
      args: [input.moderationCaseId],
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/(?:no such column|unknown column).*(?:asset_id|asset_enforcement_state)/iu.test(message)) {
      throw error
    }
    result = await input.executor.execute({
      sql: `
        SELECT moderation_action_id, moderation_case_id, community_id, post_id, comment_id,
               actor_user_id, action_type, note, created_at,
               previous_post_status, next_post_status,
               previous_content_safety_state, next_content_safety_state,
               previous_age_gate_policy, next_age_gate_policy, evidence_ref
        FROM moderation_actions
        WHERE moderation_case_id = ?1
        ORDER BY created_at ASC, moderation_action_id ASC
      `,
      args: [input.moderationCaseId],
    })
  }
  return result.rows.map((row) => serializeModerationAction(row))
}

export async function createModerationAction(input: {
  executor: DbExecutor
  moderationCase: ModerationCase
  actorUserId: string
  body: CreateModerationActionRequest
  now: string
  previousStatus?: ModerationAction["previous_post_status"]
  nextStatus?: ModerationAction["next_post_status"]
  previousAgeGatePolicy?: "none" | "18_plus" | null
  nextAgeGatePolicy?: "none" | "18_plus" | null
  previousContentSafetyState?: "pending" | "safe" | "sensitive" | "adult" | null
  nextContentSafetyState?: "safe" | "sensitive" | "adult" | null
  evidenceRef?: string | null
  assetId?: string | null
  previousAssetEnforcementState?: "active" | "quarantined" | "blocked" | null
  nextAssetEnforcementState?: "active" | "quarantined" | "blocked" | null
}): Promise<ModerationAction> {
  const moderationActionId = makeId("mac")
  if (input.assetId) {
    await input.executor.execute({
    sql: `
      INSERT INTO moderation_actions (
        moderation_action_id, moderation_case_id, community_id, post_id, comment_id,
        actor_user_id, action_type, note, created_at, previous_post_status, next_post_status,
        previous_age_gate_policy, next_age_gate_policy,
        previous_content_safety_state, next_content_safety_state, evidence_ref,
        asset_id, previous_asset_enforcement_state, next_asset_enforcement_state
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5,
        ?6, ?7, ?8, ?9, ?10, ?11,
        ?12, ?13, ?14, ?15, ?16,
        ?17, ?18, ?19
      )
    `,
    args: [
      moderationActionId,
      input.moderationCase.moderation_case_id,
      input.moderationCase.community_id,
      input.moderationCase.post_id,
      input.moderationCase.comment_id,
      input.actorUserId,
      input.body.action_type,
      input.body.note?.trim() || null,
      input.now,
      input.previousStatus ?? null,
      input.nextStatus ?? null,
      input.previousAgeGatePolicy ?? null,
      input.nextAgeGatePolicy ?? null,
      input.previousContentSafetyState ?? null,
      input.nextContentSafetyState ?? null,
      input.evidenceRef?.trim() || null,
      input.assetId ?? null,
      input.previousAssetEnforcementState ?? null,
      input.nextAssetEnforcementState ?? null,
    ],
    })
  } else {
    await input.executor.execute({
      sql: `
        INSERT INTO moderation_actions (
          moderation_action_id, moderation_case_id, community_id, post_id, comment_id,
          actor_user_id, action_type, note, created_at, previous_post_status, next_post_status,
          previous_age_gate_policy, next_age_gate_policy,
          previous_content_safety_state, next_content_safety_state, evidence_ref
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5,
          ?6, ?7, ?8, ?9, ?10, ?11,
          ?12, ?13, ?14, ?15, ?16
        )
      `,
      args: [
        moderationActionId,
        input.moderationCase.moderation_case_id,
        input.moderationCase.community_id,
        input.moderationCase.post_id,
        input.moderationCase.comment_id,
        input.actorUserId,
        input.body.action_type,
        input.body.note?.trim() || null,
        input.now,
        input.previousStatus ?? null,
        input.nextStatus ?? null,
        input.previousAgeGatePolicy ?? null,
        input.nextAgeGatePolicy ?? null,
        input.previousContentSafetyState ?? null,
        input.nextContentSafetyState ?? null,
        input.evidenceRef?.trim() || null,
      ],
    })
  }
  // Deterministic projection of the inserted row — buffer-safe (no in-tx readback).
  return {
    moderation_action_id: moderationActionId,
    moderation_case_id: input.moderationCase.moderation_case_id,
    community_id: input.moderationCase.community_id,
    post_id: input.moderationCase.post_id,
    comment_id: input.moderationCase.comment_id,
    asset_id: input.assetId ?? null,
    actor_user_id: input.actorUserId,
    action_type: input.body.action_type,
    note: input.body.note?.trim() || null,
    previous_content_safety_state: input.previousContentSafetyState ?? null,
    next_content_safety_state: input.nextContentSafetyState ?? null,
    previous_age_gate_policy: input.previousAgeGatePolicy ?? null,
    next_age_gate_policy: input.nextAgeGatePolicy ?? null,
    evidence_ref: input.evidenceRef?.trim() || null,
    previous_post_status: input.previousStatus ?? null,
    next_post_status: input.nextStatus ?? null,
    previous_asset_enforcement_state: input.previousAssetEnforcementState ?? null,
    next_asset_enforcement_state: input.nextAssetEnforcementState ?? null,
    created_at: input.now,
  }
}

export async function setAssetModerationEnforcement(input: {
  executor: DbExecutor
  assetId: string
  moderationActionId: string
  enforcementState: "active" | "quarantined" | "blocked"
  reasonCode: string
  evidenceRef: string
  now: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      UPDATE asset_enforcement
      SET enforcement_state = ?2,
          reason_code = ?3,
          authority_kind = 'moderation_action',
          authority_ref = ?4,
          moderation_action_id = ?4,
          actor_role = 'community_moderator',
          evidence_ref = ?5,
          decided_at = ?6,
          updated_at = ?6
      WHERE asset_id = ?1
    `,
    args: [
      input.assetId,
      input.enforcementState,
      input.reasonCode,
      input.moderationActionId,
      input.evidenceRef,
      input.now,
    ],
  })
}

export async function setPostModerationStatus(input: {
  executor: DbExecutor
  postId: string
  status: "published" | "hidden" | "removed"
  now: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      UPDATE posts
      SET status = ?2,
          updated_at = ?3
      WHERE post_id = ?1
    `,
    args: [input.postId, input.status, input.now],
  })
}

export async function approveReviewHeldPost(input: {
  executor: DbExecutor
  postId: string
  now: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      UPDATE posts
      SET status = 'published',
          analysis_state = 'allow',
          content_safety_state = CASE
            WHEN age_gate_policy = '18_plus' THEN content_safety_state
            ELSE 'safe'
          END,
          updated_at = ?2
      WHERE post_id = ?1
    `,
    args: [input.postId, input.now],
  })
}

export async function setPostAgeGatePolicy(input: {
  executor: DbExecutor
  postId: string
  ageGatePolicy: "none" | "18_plus"
  now: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      UPDATE posts
      SET age_gate_policy = ?2,
          updated_at = ?3
      WHERE post_id = ?1
    `,
    args: [input.postId, input.ageGatePolicy, input.now],
  })
}

export async function setPostContentRating(input: {
  executor: DbExecutor
  postId: string
  contentSafetyState: "safe" | "sensitive" | "adult"
  ageGatePolicy: "none" | "18_plus"
  now: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      UPDATE posts
      SET content_safety_state = ?2,
          age_gate_policy = ?3,
          updated_at = ?4
      WHERE post_id = ?1
    `,
    args: [input.postId, input.contentSafetyState, input.ageGatePolicy, input.now],
  })
}

export async function setCommentModerationStatus(input: {
  executor: DbExecutor
  commentId: string
  status: "published" | "hidden" | "removed"
  now: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      UPDATE comments
      SET status = ?2,
          updated_at = ?3
      WHERE comment_id = ?1
    `,
    args: [input.commentId, input.status, input.now],
  })
}
