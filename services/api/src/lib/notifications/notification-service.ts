import { nowIso } from "../helpers"
import { executeFirst, type DbExecutor } from "../db-helpers"
import { badRequestError } from "../errors"
import { getGlobalHandleRow, getProfileRow, getUserRow } from "../auth/auth-db-user-queries"
import { parseVerificationCapabilities } from "../auth/auth-serializers"
import { trackServerEvent } from "../analytics"
import { getControlPlaneClient } from "../runtime-deps"
import {
  ensureNotificationTables,
  upsertUserTask,
  resolveUserTask,
  dismissUserTask,
  listOpenUserTasks,
  insertNotificationEvent,
  insertNotificationReceipt,
  getNotificationSummary,
  listNotificationFeed,
  markNotificationsRead,
  markAllNotificationsRead,
} from "./notification-store"
import type {
  NotificationFeedResponse,
  NotificationSummary,
  NotificationTasksResponse,
  UserTask,
} from "../../types"
import type { Env } from "../../types"

const SYNTHETIC_UNIQUE_HUMAN_TASK_ID_PREFIX = "synth:unique_human:"
const UNIQUE_HUMAN_TASK_TYPE = "unique_human_verification_required"
const PROFILE_COMPLETION_TASK_TYPE = "profile_completion_suggested"
const GLOBAL_HANDLE_CLEANUP_TASK_TYPE = "global_handle_cleanup_suggested"

async function hasNotificationEventDedupeKey(executor: DbExecutor, dedupeKey: string): Promise<boolean> {
  const row = await executeFirst(executor, {
    sql: `
      SELECT event_id
      FROM notification_events
      WHERE dedupe_key = ?1
      LIMIT 1
    `,
    args: [dedupeKey],
  }) as Record<string, unknown> | null
  return Boolean(row)
}

async function trackNotificationGenerated(
  env: Env,
  executor: DbExecutor,
  input: {
    userId: string
    notificationType: string
    notificationKind: "task" | "activity"
    communityId?: string | null
    postId?: string | null
    commentId?: string | null
    taskType?: string | null
    taskPersistence?: "persisted" | "synthetic" | null
  },
): Promise<void> {
  await trackServerEvent(env, executor, {
    eventName: "notification_generated",
    source: "api",
    appSurface: "api",
    userId: input.userId,
    communityId: input.communityId ?? null,
    postId: input.postId ?? null,
    commentId: input.commentId ?? null,
    properties: {
      notification_kind: input.notificationKind,
      notification_type: input.notificationType,
      task_type: input.taskType ?? null,
      task_persistence: input.taskPersistence ?? null,
    },
  })
}

async function trackNotificationGeneratedSafely(
  env: Env,
  executor: DbExecutor,
  input: Parameters<typeof trackNotificationGenerated>[2],
): Promise<void> {
  try {
    await trackNotificationGenerated(env, executor, input)
  } catch (error) {
    console.error("[notifications] failed to track notification_generated", {
      notificationType: input.notificationType,
      notificationKind: input.notificationKind,
      taskType: input.taskType ?? null,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

async function trackNotificationMarkedReadSafely(
  env: Env,
  executor: DbExecutor,
  input: {
    userId: string
    notificationType: string
    readMode: "explicit_ids" | "mark_all"
    count: number
  },
): Promise<void> {
  try {
    await trackServerEvent(env, executor, {
      eventName: "notification_marked_read",
      source: "api",
      appSurface: "api",
      userId: input.userId,
      properties: {
        notification_kind: "activity",
        notification_type: input.notificationType,
        read_mode: input.readMode,
        open_surface: "inbox",
        count: input.count,
      },
    })
  } catch (error) {
    console.error("[notifications] failed to track notification_marked_read", {
      notificationType: input.notificationType,
      readMode: input.readMode,
      count: input.count,
      message: error instanceof Error ? error.message : String(error),
    })
  }
}

async function buildActorIdentityPayload(executor: DbExecutor, userId: string): Promise<Record<string, unknown>> {
  const profile = await getProfileRow(executor, userId).catch(() => null)
  return {
    actor_display_name: profile?.display_name?.trim() || null,
    actor_avatar_url: profile?.avatar_ref?.trim() || null,
  }
}

function buildUniqueHumanTask(userId: string): UserTask {
  const createdAt = nowIso()
  return {
    task_id: `${SYNTHETIC_UNIQUE_HUMAN_TASK_ID_PREFIX}${userId}`,
    user_id: userId,
    type: UNIQUE_HUMAN_TASK_TYPE,
    subject_type: "user",
    subject_id: userId,
    status: "open",
    priority: 100,
    payload: {
      target_path: "/onboarding?verify=human",
      verification_provider: "very",
    },
    resolved_at: null,
    dismissed_at: null,
    created_at: createdAt,
    updated_at: createdAt,
  }
}

async function needsUniqueHumanTask(executor: DbExecutor, userId: string): Promise<boolean> {
  const userRow = await getUserRow(executor, userId)
  if (!userRow) return false
  const capabilities = parseVerificationCapabilities(userRow.verification_capabilities_json)
  return capabilities.unique_human.state !== "verified"
}

function isProfileComplete(profile: Awaited<ReturnType<typeof getProfileRow>>): boolean {
  if (!profile?.display_name?.trim()) return false
  return Boolean(profile.avatar_ref?.trim() || profile.cover_ref?.trim() || profile.bio?.trim())
}

async function hasDismissedUserTask(executor: DbExecutor, input: {
  userId: string
  type: typeof PROFILE_COMPLETION_TASK_TYPE | typeof GLOBAL_HANDLE_CLEANUP_TASK_TYPE
  subjectId: string
}): Promise<boolean> {
  const row = await executeFirst(executor, {
    sql: `
      SELECT task_id
      FROM user_tasks
      WHERE user_id = ?1
        AND type = ?2
        AND subject_id = ?3
        AND status = 'dismissed'
      LIMIT 1
    `,
    args: [input.userId, input.type, input.subjectId],
  }) as Record<string, unknown> | null
  return Boolean(row)
}

async function syncProfileCompletionTask(executor: DbExecutor, userId: string): Promise<void> {
  const profile = await getProfileRow(executor, userId)
  if (isProfileComplete(profile)) {
    await resolveUserTask({
      executor,
      userId,
      type: PROFILE_COMPLETION_TASK_TYPE,
      subjectId: userId,
      resolvedAt: nowIso(),
    })
    return
  }

  if (await hasDismissedUserTask(executor, { userId, type: PROFILE_COMPLETION_TASK_TYPE, subjectId: userId })) {
    return
  }

  await upsertUserTask({
    executor,
    userId,
    type: PROFILE_COMPLETION_TASK_TYPE,
    subjectType: "profile",
    subjectId: userId,
    priority: 1,
    payload: { target_path: "/settings/profile" },
    createdAt: nowIso(),
  })
}

async function needsGlobalHandleCleanupTask(executor: DbExecutor, userId: string): Promise<boolean> {
  const profile = await getProfileRow(executor, userId)
  if (!profile) return false
  const activeGlobalHandle = await getGlobalHandleRow(executor, profile.global_handle_id)
  return activeGlobalHandle?.issuance_source === "generated_signup"
    && !Boolean(activeGlobalHandle.free_rename_consumed)
}

async function syncGlobalHandleCleanupTask(executor: DbExecutor, userId: string): Promise<void> {
  if (!(await needsGlobalHandleCleanupTask(executor, userId))) {
    await resolveUserTask({
      executor,
      userId,
      type: GLOBAL_HANDLE_CLEANUP_TASK_TYPE,
      subjectId: userId,
      resolvedAt: nowIso(),
    })
    return
  }

  if (await hasDismissedUserTask(executor, { userId, type: GLOBAL_HANDLE_CLEANUP_TASK_TYPE, subjectId: userId })) {
    return
  }

  await upsertUserTask({
    executor,
    userId,
    type: GLOBAL_HANDLE_CLEANUP_TASK_TYPE,
    subjectType: "profile",
    subjectId: userId,
    priority: 2,
    payload: { target_path: "/settings/profile" },
    createdAt: nowIso(),
  })
}

export async function createNamespaceVerificationTask(input: {
  env: Env
  userId: string
  communityId: string
  communityDisplayName: string
}): Promise<UserTask> {
  const client = getControlPlaneClient(input.env)
  try {
    await ensureNotificationTables(client)
    const result = await upsertUserTask({
      executor: client,
      userId: input.userId,
      type: "namespace_verification_required",
      subjectType: "community",
      subjectId: input.communityId,
      priority: 10,
      payload: {
        community_display_name: input.communityDisplayName,
        target_path: `/c/${input.communityId}/mod/namespace`,
      },
      createdAt: nowIso(),
    })
    if (result.wasCreated) {
      await trackNotificationGeneratedSafely(input.env, client, {
        userId: input.userId,
        notificationType: "namespace_verification_required",
        notificationKind: "task",
        communityId: input.communityId,
        taskType: "namespace_verification_required",
        taskPersistence: "persisted",
      })
    }
    return result.task
  } finally {
    client.close?.()
  }
}

export async function resolveNamespaceVerificationTask(input: {
  env: Env
  userId: string
  communityId: string
}): Promise<void> {
  const client = getControlPlaneClient(input.env)
  try {
    await ensureNotificationTables(client)
    await resolveUserTask({
      executor: client,
      userId: input.userId,
      type: "namespace_verification_required",
      subjectId: input.communityId,
      resolvedAt: nowIso(),
    })
  } finally {
    client.close?.()
  }
}

export async function emitMembershipRequestReceived(input: {
  env: Env
  reviewerUserId: string
  communityId: string
  communityDisplayName: string
  applicantUserId: string
  applicantHandle?: string | null
  requestCount: number
  requestId: string
}): Promise<UserTask> {
  const client = getControlPlaneClient(input.env)
  try {
    await ensureNotificationTables(client)
    const result = await upsertUserTask({
      executor: client,
      userId: input.reviewerUserId,
      type: "membership_review",
      subjectType: "community",
      subjectId: input.communityId,
      priority: 20,
      payload: {
        community_display_name: input.communityDisplayName,
        applicant_user_id: input.applicantUserId,
        applicant_handle: input.applicantHandle ?? null,
        membership_request_id: input.requestId,
        request_count: input.requestCount,
        target_path: `/c/${input.communityId}/mod/requests`,
      },
      createdAt: nowIso(),
    })
    if (result.wasCreated) {
      await trackNotificationGeneratedSafely(input.env, client, {
        userId: input.reviewerUserId,
        notificationType: "membership_review",
        notificationKind: "task",
        communityId: input.communityId,
        taskType: "membership_review",
        taskPersistence: "persisted",
      })
    }
    return result.task
  } finally {
    client.close?.()
  }
}

export async function resolveMembershipReviewTask(input: {
  env: Env
  reviewerUserId: string
  communityId: string
}): Promise<void> {
  const client = getControlPlaneClient(input.env)
  try {
    await ensureNotificationTables(client)
    await resolveUserTask({
      executor: client,
      userId: input.reviewerUserId,
      type: "membership_review",
      subjectId: input.communityId,
      resolvedAt: nowIso(),
    })
  } finally {
    client.close?.()
  }
}

export async function emitCommentReply(input: {
  env: Env
  actorUserId: string
  recipientUserId: string
  communityId: string
  commentExcerpt?: string | null
  postTitle?: string | null
  threadRootPostId: string
  parentCommentId: string
  replyCommentId: string
}): Promise<void> {
  if (input.actorUserId === input.recipientUserId) return

  const client = getControlPlaneClient(input.env)
  try {
    await ensureNotificationTables(client)
    const now = nowIso()
    const actorPayload = await buildActorIdentityPayload(client, input.actorUserId)
    const dedupeKey = `comment_reply:${input.replyCommentId}:${input.recipientUserId}`
    const alreadyExists = await hasNotificationEventDedupeKey(client, dedupeKey)
    const eventId = await insertNotificationEvent({
      executor: client,
      type: "comment_reply",
      actorUserId: input.actorUserId,
      subjectType: "comment",
      subjectId: input.parentCommentId,
      objectType: "comment",
      objectId: input.replyCommentId,
      payload: {
        ...actorPayload,
        community_id: input.communityId,
        comment_excerpt: input.commentExcerpt ?? null,
        post_title: input.postTitle ?? null,
        target_path: `/p/${input.threadRootPostId}`,
        thread_root_post_id: input.threadRootPostId,
      },
      dedupeKey,
      createdAt: now,
    })
    await insertNotificationReceipt({
      executor: client,
      eventId,
      recipientUserId: input.recipientUserId,
      createdAt: now,
    })
    if (!alreadyExists) {
      await trackNotificationGeneratedSafely(input.env, client, {
        userId: input.recipientUserId,
        notificationType: "comment_reply",
        notificationKind: "activity",
        communityId: input.communityId,
        postId: input.threadRootPostId,
        commentId: input.replyCommentId,
      })
    }
  } finally {
    client.close?.()
  }
}

export async function emitPostCommented(input: {
  env: Env
  actorUserId: string
  postAuthorUserId: string
  communityId: string
  commentExcerpt?: string | null
  postTitle?: string | null
  postId: string
  commentId: string
}): Promise<void> {
  if (input.actorUserId === input.postAuthorUserId) return

  const client = getControlPlaneClient(input.env)
  try {
    await ensureNotificationTables(client)
    const now = nowIso()
    const actorPayload = await buildActorIdentityPayload(client, input.actorUserId)
    const dedupeKey = `post_commented:${input.commentId}:${input.postAuthorUserId}`
    const alreadyExists = await hasNotificationEventDedupeKey(client, dedupeKey)
    const eventId = await insertNotificationEvent({
      executor: client,
      type: "post_commented",
      actorUserId: input.actorUserId,
      subjectType: "post",
      subjectId: input.postId,
      objectType: "comment",
      objectId: input.commentId,
      payload: {
        ...actorPayload,
        community_id: input.communityId,
        comment_excerpt: input.commentExcerpt ?? null,
        post_title: input.postTitle ?? null,
        target_path: `/p/${input.postId}`,
      },
      dedupeKey,
      createdAt: now,
    })
    await insertNotificationReceipt({
      executor: client,
      eventId,
      recipientUserId: input.postAuthorUserId,
      createdAt: now,
    })
    if (!alreadyExists) {
      await trackNotificationGeneratedSafely(input.env, client, {
        userId: input.postAuthorUserId,
        notificationType: "post_commented",
        notificationKind: "activity",
        communityId: input.communityId,
        postId: input.postId,
        commentId: input.commentId,
      })
    }
  } finally {
    client.close?.()
  }
}

export async function emitRoyaltyEarned(input: {
  env: Env
  recipientUserId: string
  communityId: string
  assetId: string
  storyIpId: string
  amountWipWei: string
  buyerWalletAddress?: string | null
  txHash?: string | null
  purchaseId: string
  title?: string | null
}): Promise<void> {
  const client = getControlPlaneClient(input.env)
  try {
    await ensureNotificationTables(client)
    const now = nowIso()
    const dedupeKey = `royalty_earned:${input.purchaseId}:${input.assetId}`
    const alreadyExists = await hasNotificationEventDedupeKey(client, dedupeKey)
    const eventId = await insertNotificationEvent({
      executor: client,
      type: "royalty_earned",
      actorUserId: null,
      subjectType: "asset",
      subjectId: input.assetId,
      objectType: "purchase",
      objectId: input.purchaseId,
      payload: {
        community_id: input.communityId,
        asset_id: input.assetId,
        title: input.title ?? null,
        amount_wip_wei: input.amountWipWei,
        story_ip_id: input.storyIpId,
        buyer_wallet_address: input.buyerWalletAddress ?? null,
        tx_hash: input.txHash ?? null,
        target_path: "/inbox?tab=royalties",
      },
      dedupeKey,
      createdAt: now,
    })
    await insertNotificationReceipt({
      executor: client,
      eventId,
      recipientUserId: input.recipientUserId,
      createdAt: now,
    })
    if (!alreadyExists) {
      await trackNotificationGeneratedSafely(input.env, client, {
        userId: input.recipientUserId,
        notificationType: "royalty_earned",
        notificationKind: "activity",
        communityId: input.communityId,
      })
    }
  } finally {
    client.close?.()
  }
}

export async function emitRoyaltyEarnedBatch(input: {
  env: Env
  buyerUserId: string
  events: Array<{
    recipientUserId: string
    communityId: string
    assetId: string
    storyIpId: string
    amountWipWei: string
    buyerWalletAddress?: string | null
    txHash?: string | null
    purchaseId: string
    title?: string | null
  }>
}): Promise<void> {
  for (const event of input.events) {
    if (event.recipientUserId === input.buyerUserId) {
      continue
    }
    await emitRoyaltyEarned({
      env: input.env,
      ...event,
    })
  }
}

export async function getNotificationsSummary(input: {
  env: Env
  userId: string
}): Promise<NotificationSummary> {
  const client = getControlPlaneClient(input.env)
  try {
    await ensureNotificationTables(client)
    await syncProfileCompletionTask(client, input.userId)
    await syncGlobalHandleCleanupTask(client, input.userId)
    const summary = await getNotificationSummary({ executor: client, userId: input.userId })
    if (!(await needsUniqueHumanTask(client, input.userId))) {
      return summary
    }
    const openTaskCount = summary.open_task_count + 1
    return {
      ...summary,
      open_task_count: openTaskCount,
      has_unread: openTaskCount > 0 || summary.unread_activity_count > 0,
    }
  } finally {
    client.close?.()
  }
}

export async function getNotificationsTasks(input: {
  env: Env
  userId: string
}): Promise<NotificationTasksResponse> {
  const client = getControlPlaneClient(input.env)

  try {
    await ensureNotificationTables(client)
    await syncProfileCompletionTask(client, input.userId)
    await syncGlobalHandleCleanupTask(client, input.userId)

    const tasks = await listOpenUserTasks({ executor: client, userId: input.userId })
    const syntheticTasks: import("../../types").UserTask[] = []

    if (await needsUniqueHumanTask(client, input.userId)) {
      syntheticTasks.push(buildUniqueHumanTask(input.userId))
    }

    const existingTypes = new Set(tasks.items.map((task) => task.type))
    const filteredSynthetic = syntheticTasks.filter((task) => !existingTypes.has(task.type))

    return {
      items: [
        ...filteredSynthetic,
        ...tasks.items.filter((task) => task.type !== UNIQUE_HUMAN_TASK_TYPE),
      ],
    }
  } finally {
    client.close?.()
  }
}

export async function getNotificationsFeed(input: {
  env: Env
  userId: string
  cursor?: string | null
  limit?: number
}): Promise<NotificationFeedResponse> {
  const client = getControlPlaneClient(input.env)
  try {
    await ensureNotificationTables(client)
    return await listNotificationFeed({
      executor: client,
      userId: input.userId,
      cursor: input.cursor,
      limit: input.limit,
    })
  } finally {
    client.close?.()
  }
}

export async function markRead(input: {
  env: Env
  userId: string
  eventIds: string[]
}): Promise<void> {
  const client = getControlPlaneClient(input.env)
  try {
    await ensureNotificationTables(client)
    const countsByType = input.eventIds.length === 0
      ? await markAllNotificationsRead({ executor: client, userId: input.userId, readAt: nowIso() })
      : await markNotificationsRead({ executor: client, userId: input.userId, eventIds: input.eventIds, readAt: nowIso() })
    for (const [notificationType, count] of Object.entries(countsByType)) {
      if (count <= 0) continue
      await trackNotificationMarkedReadSafely(input.env, client, {
        userId: input.userId,
        notificationType,
        readMode: input.eventIds.length === 0 ? "mark_all" : "explicit_ids",
        count,
      })
    }
  } finally {
    client.close?.()
  }
}

export async function dismissTask(input: {
  env: Env
  userId: string
  taskId: string
}): Promise<UserTask | null> {
  if (input.taskId.startsWith(SYNTHETIC_UNIQUE_HUMAN_TASK_ID_PREFIX)) {
    throw badRequestError("This task cannot be dismissed")
  }
  const client = getControlPlaneClient(input.env)
  try {
    await ensureNotificationTables(client)
    return await dismissUserTask({ executor: client, taskId: input.taskId, userId: input.userId, dismissedAt: nowIso() })
  } finally {
    client.close?.()
  }
}
