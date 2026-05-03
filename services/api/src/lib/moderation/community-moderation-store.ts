import type { DbExecutor } from "../db-helpers"
import { executeFirst } from "../db-helpers"
import { internalError } from "../errors"
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
    actor_user_id: requiredString(row, "actor_user_id"),
    action_type: requiredString(row, "action_type") as ModerationAction["action_type"],
    note: stringOrNull(rowValue(row, "note")),
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
  const row = await executeFirst(input.executor, {
    sql: `
      SELECT moderation_signal_id, community_id, post_id, comment_id, analysis_result_ref,
             source, signal_type, severity, provider, provider_label, evidence_ref, created_at
      FROM moderation_signals
      WHERE moderation_signal_id = ?1
      LIMIT 1
    `,
    args: [moderationSignalId],
  })
  if (!row) {
    throw internalError("Moderation signal is missing after insert")
  }
  return serializeModerationSignal(row)
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
  const created = await getModerationCaseById({
    executor: input.executor,
    moderationCaseId,
  })
  if (!created) {
    throw internalError("Moderation case is missing after insert")
  }
  return created
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
  const created = await executeFirst(input.executor, {
    sql: `
      SELECT user_report_id, community_id, post_id, comment_id, reporter_user_id, reason_code, note, created_at
      FROM user_reports
      WHERE user_report_id = ?1
      LIMIT 1
    `,
    args: [userReportId],
  })
  if (!created) {
    throw internalError("User report is missing after insert")
  }
  return serializeUserReport(created)
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
        p.body as post_body, p.caption as post_caption, p.media_refs_json
      FROM moderation_cases mc
      LEFT JOIN posts p ON p.post_id = mc.post_id
      WHERE mc.community_id = ?1
      ORDER BY CASE mc.status WHEN 'open' THEN 0 ELSE 1 END ASC, mc.updated_at DESC, mc.moderation_case_id DESC
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
  const result = await input.executor.execute({
    sql: `
      SELECT moderation_action_id, moderation_case_id, community_id, post_id, comment_id,
             actor_user_id, action_type, note, created_at
      FROM moderation_actions
      WHERE moderation_case_id = ?1
      ORDER BY created_at ASC, moderation_action_id ASC
    `,
    args: [input.moderationCaseId],
  })
  return result.rows.map((row) => serializeModerationAction(row))
}

export async function createModerationAction(input: {
  executor: DbExecutor
  moderationCase: ModerationCase
  actorUserId: string
  body: CreateModerationActionRequest
  now: string
  previousStatus?: string | null
  nextStatus?: string | null
  previousAgeGatePolicy?: "none" | "18_plus" | null
  nextAgeGatePolicy?: "none" | "18_plus" | null
}): Promise<ModerationAction> {
  const moderationActionId = makeId("mac")
  await input.executor.execute({
    sql: `
      INSERT INTO moderation_actions (
        moderation_action_id, moderation_case_id, community_id, post_id, comment_id,
        actor_user_id, action_type, note, created_at, previous_post_status, next_post_status,
        previous_age_gate_policy, next_age_gate_policy
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5,
        ?6, ?7, ?8, ?9, ?10, ?11,
        ?12, ?13
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
    ],
  })
  const created = await executeFirst(input.executor, {
    sql: `
      SELECT moderation_action_id, moderation_case_id, community_id, post_id, comment_id,
             actor_user_id, action_type, note, created_at
      FROM moderation_actions
      WHERE moderation_action_id = ?1
      LIMIT 1
    `,
    args: [moderationActionId],
  })
  if (!created) {
    throw internalError("Moderation action is missing after insert")
  }
  return serializeModerationAction(created)
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
