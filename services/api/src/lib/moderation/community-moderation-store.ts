import type { Client, Transaction } from "@libsql/client"
import { makeId } from "../helpers"
import { conflictError, internalError, notFoundError } from "../errors"
import { requiredString, rowValue, stringOrNull } from "../sql-row"
import { getPostById } from "../posts/community-post-store"
import type {
  ModerationAction,
  ModerationActionType,
  ModerationCase,
  ModerationCaseDetail,
  ModerationCaseOpenedBy,
  ModerationCaseStatus,
  ModerationQueueScope,
  ModerationSignal,
  ModerationSignalSeverity,
  Post,
  SongModerationResultDoc,
  UserReport,
  UserReportReasonCode,
} from "../../types"

type ModerationExecutor = Pick<Client, "execute"> | Pick<Transaction, "execute">

function severityRank(value: ModerationSignalSeverity): number {
  switch (value) {
    case "high":
      return 3
    case "medium":
      return 2
    case "low":
    default:
      return 1
  }
}

function maxSeverity(a: ModerationSignalSeverity, b: ModerationSignalSeverity): ModerationSignalSeverity {
  return severityRank(a) >= severityRank(b) ? a : b
}

function mergeOpenedBy(current: ModerationCaseOpenedBy, next: ModerationCaseOpenedBy): ModerationCaseOpenedBy {
  if (current === next) {
    return current
  }
  if (current === "mixed" || next === "mixed") {
    return "mixed"
  }
  return "mixed"
}

function toModerationCase(row: unknown): ModerationCase {
  return {
    moderation_case_id: requiredString(row, "moderation_case_id"),
    community_id: requiredString(row, "community_id"),
    post_id: requiredString(row, "post_id"),
    status: requiredString(row, "status") as ModerationCaseStatus,
    queue_scope: requiredString(row, "queue_scope") as ModerationQueueScope,
    priority: requiredString(row, "priority") as ModerationSignalSeverity,
    opened_by: requiredString(row, "opened_by") as ModerationCaseOpenedBy,
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
    resolved_at: stringOrNull(rowValue(row, "resolved_at")),
  }
}

function toModerationSignal(row: unknown): ModerationSignal {
  return {
    moderation_signal_id: requiredString(row, "moderation_signal_id"),
    community_id: requiredString(row, "community_id"),
    post_id: requiredString(row, "post_id"),
    moderation_case_id: stringOrNull(rowValue(row, "moderation_case_id")),
    analysis_result_ref: stringOrNull(rowValue(row, "analysis_result_ref")),
    source: "platform_analysis",
    signal_type: requiredString(row, "signal_type"),
    severity: requiredString(row, "severity") as ModerationSignalSeverity,
    provider: requiredString(row, "provider"),
    provider_label: requiredString(row, "provider_label"),
    evidence_ref: stringOrNull(rowValue(row, "evidence_ref")),
    created_at: requiredString(row, "created_at"),
  }
}

function toUserReport(row: unknown): UserReport {
  return {
    user_report_id: requiredString(row, "user_report_id"),
    community_id: requiredString(row, "community_id"),
    post_id: requiredString(row, "post_id"),
    moderation_case_id: stringOrNull(rowValue(row, "moderation_case_id")),
    reporter_user_id: requiredString(row, "reporter_user_id"),
    reason_code: requiredString(row, "reason_code") as UserReportReasonCode,
    note: stringOrNull(rowValue(row, "note")),
    created_at: requiredString(row, "created_at"),
  }
}

function toModerationAction(row: unknown): ModerationAction {
  return {
    moderation_action_id: requiredString(row, "moderation_action_id"),
    moderation_case_id: requiredString(row, "moderation_case_id"),
    community_id: requiredString(row, "community_id"),
    post_id: requiredString(row, "post_id"),
    actor_user_id: requiredString(row, "actor_user_id"),
    action_type: requiredString(row, "action_type") as ModerationActionType,
    note: stringOrNull(rowValue(row, "note")),
    previous_post_status: stringOrNull(rowValue(row, "previous_post_status")) as Post["status"] | null,
    next_post_status: stringOrNull(rowValue(row, "next_post_status")) as Post["status"] | null,
    previous_age_gate_policy: stringOrNull(rowValue(row, "previous_age_gate_policy")) as Post["age_gate_policy"] | null,
    next_age_gate_policy: stringOrNull(rowValue(row, "next_age_gate_policy")) as Post["age_gate_policy"] | null,
    created_at: requiredString(row, "created_at"),
  }
}

async function getOpenModerationCaseByPostId(input: {
  client: ModerationExecutor
  communityId: string
  postId: string
}): Promise<ModerationCase | null> {
  const result = await input.client.execute({
    sql: `
      SELECT moderation_case_id, community_id, post_id, status, queue_scope, priority, opened_by, created_at, updated_at, resolved_at
      FROM moderation_cases
      WHERE community_id = ?1
        AND post_id = ?2
        AND status = 'open'
      LIMIT 1
    `,
    args: [input.communityId, input.postId],
  })
  const row = result.rows[0]
  return row ? toModerationCase(row) : null
}

async function getModerationCaseById(input: {
  client: ModerationExecutor
  communityId: string
  moderationCaseId: string
}): Promise<ModerationCase | null> {
  const result = await input.client.execute({
    sql: `
      SELECT moderation_case_id, community_id, post_id, status, queue_scope, priority, opened_by, created_at, updated_at, resolved_at
      FROM moderation_cases
      WHERE community_id = ?1
        AND moderation_case_id = ?2
      LIMIT 1
    `,
    args: [input.communityId, input.moderationCaseId],
  })
  const row = result.rows[0]
  return row ? toModerationCase(row) : null
}

async function countRecentReportsForPost(input: {
  client: ModerationExecutor
  communityId: string
  postId: string
  since: string
}): Promise<number> {
  const result = await input.client.execute({
    sql: `
      SELECT COUNT(*) AS count
      FROM user_reports
      WHERE community_id = ?1
        AND post_id = ?2
        AND created_at >= ?3
    `,
    args: [input.communityId, input.postId, input.since],
  })
  return Number(result.rows[0]?.count ?? 0)
}

async function insertModerationCaseIfMissing(input: {
  client: ModerationExecutor
  communityId: string
  postId: string
  queueScope: ModerationQueueScope
  priority: ModerationSignalSeverity
  openedBy: ModerationCaseOpenedBy
  createdAt: string
}): Promise<ModerationCase> {
  const moderationCaseId = makeId("mcs")
  await input.client.execute({
    sql: `
      INSERT OR IGNORE INTO moderation_cases (
        moderation_case_id, community_id, post_id, status, queue_scope, priority, opened_by, created_at, updated_at, resolved_at
      ) VALUES (
        ?1, ?2, ?3, 'open', ?4, ?5, ?6, ?7, ?7, NULL
      )
    `,
    args: [
      moderationCaseId,
      input.communityId,
      input.postId,
      input.queueScope,
      input.priority,
      input.openedBy,
      input.createdAt,
    ],
  })
  const existing = await getOpenModerationCaseByPostId({
    client: input.client,
    communityId: input.communityId,
    postId: input.postId,
  })
  if (!existing) {
    throw internalError("Open moderation case missing after insert")
  }
  return existing
}

export async function ensureOpenModerationCase(input: {
  client: ModerationExecutor
  communityId: string
  postId: string
  queueScope: ModerationQueueScope
  priority: ModerationSignalSeverity
  openedBy: ModerationCaseOpenedBy
  updatedAt: string
}): Promise<ModerationCase> {
  const existing = await insertModerationCaseIfMissing({
    client: input.client,
    communityId: input.communityId,
    postId: input.postId,
    queueScope: input.queueScope,
    priority: input.priority,
    openedBy: input.openedBy,
    createdAt: input.updatedAt,
  })
  const nextQueueScope = existing.queue_scope === "platform" || input.queueScope === "platform"
    ? "platform"
    : "community"
  const nextPriority = maxSeverity(existing.priority, input.priority)
  const nextOpenedBy = mergeOpenedBy(existing.opened_by, input.openedBy)

  if (
    existing.queue_scope === nextQueueScope
    && existing.priority === nextPriority
    && existing.opened_by === nextOpenedBy
  ) {
    return existing
  }

  await input.client.execute({
    sql: `
      UPDATE moderation_cases
      SET queue_scope = ?2,
          priority = ?3,
          opened_by = ?4,
          updated_at = ?5
      WHERE moderation_case_id = ?1
    `,
    args: [
      existing.moderation_case_id,
      nextQueueScope,
      nextPriority,
      nextOpenedBy,
      input.updatedAt,
    ],
  })
  const updated = await getModerationCaseById({
    client: input.client,
    communityId: input.communityId,
    moderationCaseId: existing.moderation_case_id,
  })
  if (!updated) {
    throw internalError("Moderation case missing after update")
  }
  return updated
}

export async function createUserReportAndAttachToCase(input: {
  client: ModerationExecutor
  communityId: string
  postId: string
  reporterUserId: string
  reasonCode: UserReportReasonCode
  note: string | null
  createdAt: string
}): Promise<UserReport> {
  const existing = await input.client.execute({
    sql: `
      SELECT user_report_id
      FROM user_reports
      WHERE community_id = ?1
        AND post_id = ?2
        AND reporter_user_id = ?3
      LIMIT 1
    `,
    args: [input.communityId, input.postId, input.reporterUserId],
  })
  if (existing.rows.length > 0) {
    throw conflictError("You already reported this post")
  }

  const moderationCase = await ensureOpenModerationCase({
    client: input.client,
    communityId: input.communityId,
    postId: input.postId,
    queueScope: "community",
    priority: "low",
    openedBy: "user_report",
    updatedAt: input.createdAt,
  })

  const userReportId = makeId("urp")
  await input.client.execute({
    sql: `
      INSERT INTO user_reports (
        user_report_id, community_id, post_id, moderation_case_id, reporter_user_id, reason_code, note, created_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8
      )
    `,
    args: [
      userReportId,
      input.communityId,
      input.postId,
      moderationCase.moderation_case_id,
      input.reporterUserId,
      input.reasonCode,
      input.note,
      input.createdAt,
    ],
  })

  const recentReportCount = await countRecentReportsForPost({
    client: input.client,
    communityId: input.communityId,
    postId: input.postId,
    since: new Date(Date.now() - (24 * 60 * 60 * 1000)).toISOString(),
  })
  const reportPriority: ModerationSignalSeverity = recentReportCount >= 3
    ? "high"
    : recentReportCount === 2
      ? "medium"
      : "low"
  await ensureOpenModerationCase({
    client: input.client,
    communityId: input.communityId,
    postId: input.postId,
    queueScope: moderationCase.queue_scope,
    priority: reportPriority,
    openedBy: moderationCase.opened_by,
    updatedAt: input.createdAt,
  })

  const created = await input.client.execute({
    sql: `
      SELECT user_report_id, community_id, post_id, moderation_case_id, reporter_user_id, reason_code, note, created_at
      FROM user_reports
      WHERE user_report_id = ?1
      LIMIT 1
    `,
    args: [userReportId],
  })
  const row = created.rows[0]
  if (!row) {
    throw internalError("User report missing after insert")
  }
  return toUserReport(row)
}

type SongModerationSignalDraft = {
  signalType: string
  severity: ModerationSignalSeverity
  providerLabel: string
}

function buildSongModerationSignals(result: SongModerationResultDoc): SongModerationSignalDraft[] {
  const signals: SongModerationSignalDraft[] = []
  const push = (signalType: string, severity: ModerationSignalSeverity, providerLabel: string) => {
    if (!signals.some((entry) => entry.signalType === signalType)) {
      signals.push({ signalType, severity, providerLabel })
    }
  }

  if (result.sexual_minors || result.cover_art_sexual_minors) {
    push("sexual_content_minors", "high", "Sexual content involving minors")
  }
  if (result.blocked || result.cover_art_blocked) {
    push("blocked", "high", "Provider blocked content")
  }
  if (result.sexual_content === "adult" || result.sexual_content === "graphic") {
    push("explicit_sexual_content", "high", "Explicit sexual content")
  } else if (result.sexual_content === "mild") {
    push("sexual_content", "medium", "Sexual content")
  }
  if (result.cover_art_sexual_content === "adult" || result.cover_art_sexual_content === "graphic") {
    push("cover_art_explicit_sexual_content", "high", "Explicit sexual cover art")
  } else if (result.cover_art_sexual_content === "mild") {
    push("cover_art_sexual_content", "medium", "Sexual cover art")
  }
  if (result.self_harm) {
    push("self_harm", "medium", "Self-harm content")
  }
  if (result.violence) {
    push("violence", "medium", "Violent content")
  }
  if (result.hate_or_harassment) {
    push("hate_or_harassment", "medium", "Hate or harassment")
  }
  if (signals.length === 0 && result.review_required) {
    push("review_required", "medium", "Provider requires review")
  }

  return signals
}

export async function attachSongModerationSignalsAndCase(input: {
  client: ModerationExecutor
  communityId: string
  postId: string
  analysisResultRef: string
  moderationResult: SongModerationResultDoc
  createdAt: string
}): Promise<ModerationCase | null> {
  if (!input.moderationResult.review_required && !input.moderationResult.blocked) {
    return null
  }

  const signals = buildSongModerationSignals(input.moderationResult)
  const queueScope: ModerationQueueScope = (
    input.moderationResult.blocked
    || input.moderationResult.sexual_minors
    || input.moderationResult.cover_art_blocked
    || input.moderationResult.cover_art_sexual_minors
  )
    ? "platform"
    : "community"
  const priority: ModerationSignalSeverity = queueScope === "platform" ? "high" : "medium"
  const moderationCase = await ensureOpenModerationCase({
    client: input.client,
    communityId: input.communityId,
    postId: input.postId,
    queueScope,
    priority,
    openedBy: "platform_analysis",
    updatedAt: input.createdAt,
  })

  for (const signal of signals) {
    const existing = await input.client.execute({
      sql: `
        SELECT moderation_signal_id
        FROM moderation_signals
        WHERE post_id = ?1
          AND analysis_result_ref = ?2
          AND signal_type = ?3
        LIMIT 1
      `,
      args: [input.postId, input.analysisResultRef, signal.signalType],
    })
    if (existing.rows.length > 0) {
      continue
    }
    await input.client.execute({
      sql: `
        INSERT INTO moderation_signals (
          moderation_signal_id, community_id, post_id, moderation_case_id, analysis_result_ref, source,
          signal_type, severity, provider, provider_label, evidence_ref, created_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, 'platform_analysis',
          ?6, ?7, 'openrouter', ?8, ?9, ?10
        )
      `,
      args: [
        makeId("msg"),
        input.communityId,
        input.postId,
        moderationCase.moderation_case_id,
        input.analysisResultRef,
        signal.signalType,
        signal.severity,
        signal.providerLabel,
        input.analysisResultRef,
        input.createdAt,
      ],
    })
  }

  return moderationCase
}

export async function listModerationCases(input: {
  client: ModerationExecutor
  communityId: string
  status?: ModerationCaseStatus | null
}): Promise<ModerationCase[]> {
  const status = input.status ?? "open"
  const result = await input.client.execute({
    sql: `
      SELECT moderation_case_id, community_id, post_id, status, queue_scope, priority, opened_by, created_at, updated_at, resolved_at
      FROM moderation_cases
      WHERE community_id = ?1
        AND status = ?2
      ORDER BY updated_at DESC, moderation_case_id DESC
    `,
    args: [input.communityId, status],
  })
  return result.rows.map((row) => toModerationCase(row))
}

async function listModerationSignalsByCase(input: {
  client: ModerationExecutor
  moderationCaseId: string
}): Promise<ModerationSignal[]> {
  const result = await input.client.execute({
    sql: `
      SELECT moderation_signal_id, community_id, post_id, moderation_case_id, analysis_result_ref, source, signal_type, severity, provider, provider_label, evidence_ref, created_at
      FROM moderation_signals
      WHERE moderation_case_id = ?1
      ORDER BY created_at ASC, moderation_signal_id ASC
    `,
    args: [input.moderationCaseId],
  })
  return result.rows.map((row) => toModerationSignal(row))
}

async function listUserReportsByCase(input: {
  client: ModerationExecutor
  moderationCaseId: string
}): Promise<UserReport[]> {
  const result = await input.client.execute({
    sql: `
      SELECT user_report_id, community_id, post_id, moderation_case_id, reporter_user_id, reason_code, note, created_at
      FROM user_reports
      WHERE moderation_case_id = ?1
      ORDER BY created_at ASC, user_report_id ASC
    `,
    args: [input.moderationCaseId],
  })
  return result.rows.map((row) => toUserReport(row))
}

async function listModerationActionsByCase(input: {
  client: ModerationExecutor
  moderationCaseId: string
}): Promise<ModerationAction[]> {
  const result = await input.client.execute({
    sql: `
      SELECT moderation_action_id, moderation_case_id, community_id, post_id, actor_user_id, action_type, note,
             previous_post_status, next_post_status, previous_age_gate_policy, next_age_gate_policy, created_at
      FROM moderation_actions
      WHERE moderation_case_id = ?1
      ORDER BY created_at ASC, moderation_action_id ASC
    `,
    args: [input.moderationCaseId],
  })
  return result.rows.map((row) => toModerationAction(row))
}

export async function getModerationCaseDetail(input: {
  client: ModerationExecutor
  communityId: string
  moderationCaseId: string
}): Promise<ModerationCaseDetail> {
  const moderationCase = await getModerationCaseById({
    client: input.client,
    communityId: input.communityId,
    moderationCaseId: input.moderationCaseId,
  })
  if (!moderationCase) {
    throw notFoundError("Moderation case not found")
  }
  const post = await getPostById(input.client, moderationCase.post_id)
  if (!post) {
    throw notFoundError("Post not found")
  }
  const [signals, reports, actions] = await Promise.all([
    listModerationSignalsByCase({ client: input.client, moderationCaseId: moderationCase.moderation_case_id }),
    listUserReportsByCase({ client: input.client, moderationCaseId: moderationCase.moderation_case_id }),
    listModerationActionsByCase({ client: input.client, moderationCaseId: moderationCase.moderation_case_id }),
  ])
  return {
    case: moderationCase,
    post,
    signals,
    reports,
    actions,
  }
}

function deriveRestoreTargetStatus(input: {
  post: Post
  actions: ModerationAction[]
}): { status: Post["status"]; ageGatePolicy: Post["age_gate_policy"] } {
  for (let index = input.actions.length - 1; index >= 0; index -= 1) {
    const action = input.actions[index]
    const changedPostStatus = action.previous_post_status != null && action.next_post_status != null && action.previous_post_status !== action.next_post_status
    const changedAgeGate = action.previous_age_gate_policy != null && action.next_age_gate_policy != null && action.previous_age_gate_policy !== action.next_age_gate_policy
    if (changedPostStatus || changedAgeGate) {
      return {
        status: action.previous_post_status ?? input.post.status,
        ageGatePolicy: action.previous_age_gate_policy ?? input.post.age_gate_policy,
      }
    }
  }

  const fallbackStatus: Post["status"] = input.post.analysis_state === "allow"
    ? "published"
    : input.post.analysis_state === "allow_with_required_reference"
      ? "draft"
      : input.post.analysis_state === "review_required"
        ? "draft"
        : "hidden"

  return {
    status: fallbackStatus,
    ageGatePolicy: input.post.age_gate_policy,
  }
}

async function updatePostModerationState(input: {
  client: ModerationExecutor
  postId: string
  status: Post["status"]
  ageGatePolicy: Post["age_gate_policy"]
  updatedAt: string
}): Promise<Post> {
  await input.client.execute({
    sql: `
      UPDATE posts
      SET status = ?2,
          age_gate_policy = ?3,
          updated_at = ?4
      WHERE post_id = ?1
    `,
    args: [input.postId, input.status, input.ageGatePolicy, input.updatedAt],
  })
  const updated = await getPostById(input.client, input.postId)
  if (!updated) {
    throw notFoundError("Post not found")
  }
  return updated
}

export async function resolveModerationCaseWithAction(input: {
  client: ModerationExecutor
  communityId: string
  moderationCaseId: string
  actorUserId: string
  actionType: ModerationActionType
  note: string | null
  createdAt: string
}): Promise<{ detail: ModerationCaseDetail; postUpdated: boolean }> {
  const moderationCase = await getModerationCaseById({
    client: input.client,
    communityId: input.communityId,
    moderationCaseId: input.moderationCaseId,
  })
  if (!moderationCase) {
    throw notFoundError("Moderation case not found")
  }
  if (moderationCase.status !== "open") {
    throw conflictError("Moderation case is already resolved")
  }

  const post = await getPostById(input.client, moderationCase.post_id)
  if (!post) {
    throw notFoundError("Post not found")
  }
  const existingActions = await listModerationActionsByCase({
    client: input.client,
    moderationCaseId: moderationCase.moderation_case_id,
  })

  let nextStatus = post.status
  let nextAgeGatePolicy = post.age_gate_policy
  switch (input.actionType) {
    case "hide":
      nextStatus = "hidden"
      break
    case "remove":
      nextStatus = "removed"
      break
    case "restore": {
      const restored = deriveRestoreTargetStatus({
        post,
        actions: existingActions,
      })
      nextStatus = restored.status
      nextAgeGatePolicy = restored.ageGatePolicy
      break
    }
    case "age_gate":
      nextAgeGatePolicy = "18_plus"
      break
    case "dismiss":
      break
  }

  let updatedPost = post
  const postUpdated = nextStatus !== post.status || nextAgeGatePolicy !== post.age_gate_policy
  if (postUpdated) {
    updatedPost = await updatePostModerationState({
      client: input.client,
      postId: post.post_id,
      status: nextStatus,
      ageGatePolicy: nextAgeGatePolicy,
      updatedAt: input.createdAt,
    })
  }

  await input.client.execute({
    sql: `
      INSERT INTO moderation_actions (
        moderation_action_id, moderation_case_id, community_id, post_id, actor_user_id, action_type, note,
        previous_post_status, next_post_status, previous_age_gate_policy, next_age_gate_policy, created_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7,
        ?8, ?9, ?10, ?11, ?12
      )
    `,
    args: [
      makeId("mac"),
      moderationCase.moderation_case_id,
      moderationCase.community_id,
      moderationCase.post_id,
      input.actorUserId,
      input.actionType,
      input.note,
      post.status,
      updatedPost.status,
      post.age_gate_policy,
      updatedPost.age_gate_policy,
      input.createdAt,
    ],
  })

  await input.client.execute({
    sql: `
      UPDATE moderation_cases
      SET status = 'resolved',
          updated_at = ?2,
          resolved_at = ?2
      WHERE moderation_case_id = ?1
    `,
    args: [moderationCase.moderation_case_id, input.createdAt],
  })

  return {
    detail: await getModerationCaseDetail({
      client: input.client,
      communityId: input.communityId,
      moderationCaseId: moderationCase.moderation_case_id,
    }),
    postUpdated,
  }
}
