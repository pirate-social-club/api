import { nowIso } from "../helpers"
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

export async function createNamespaceVerificationTask(input: {
  env: Env
  userId: string
  communityId: string
  communityDisplayName: string
}): Promise<UserTask> {
  const client = getControlPlaneClient(input.env)
  try {
    await ensureNotificationTables(client)
    return await upsertUserTask({
      executor: client,
      userId: input.userId,
      type: "namespace_verification_required",
      subjectType: "community",
      subjectId: input.communityId,
      priority: 10,
      payload: { community_display_name: input.communityDisplayName },
      createdAt: nowIso(),
    })
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
    return await upsertUserTask({
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
    const eventId = await insertNotificationEvent({
      executor: client,
      type: "comment_reply",
      actorUserId: input.actorUserId,
      subjectType: "comment",
      subjectId: input.parentCommentId,
      objectType: "comment",
      objectId: input.replyCommentId,
      payload: {
        community_id: input.communityId,
        comment_excerpt: input.commentExcerpt ?? null,
        post_title: input.postTitle ?? null,
        target_path: `/p/${input.threadRootPostId}`,
        thread_root_post_id: input.threadRootPostId,
      },
      dedupeKey: `comment_reply:${input.replyCommentId}:${input.recipientUserId}`,
      createdAt: now,
    })
    await insertNotificationReceipt({
      executor: client,
      eventId,
      recipientUserId: input.recipientUserId,
      createdAt: now,
    })
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
    const eventId = await insertNotificationEvent({
      executor: client,
      type: "post_commented",
      actorUserId: input.actorUserId,
      subjectType: "post",
      subjectId: input.postId,
      objectType: "comment",
      objectId: input.commentId,
      payload: {
        community_id: input.communityId,
        comment_excerpt: input.commentExcerpt ?? null,
        post_title: input.postTitle ?? null,
        target_path: `/p/${input.postId}`,
      },
      dedupeKey: `post_commented:${input.commentId}:${input.postAuthorUserId}`,
      createdAt: now,
    })
    await insertNotificationReceipt({
      executor: client,
      eventId,
      recipientUserId: input.postAuthorUserId,
      createdAt: now,
    })
  } finally {
    client.close?.()
  }
}

export async function getNotificationsSummary(input: {
  env: Env
  userId: string
}): Promise<NotificationSummary> {
  const client = getControlPlaneClient(input.env)
  try {
    await ensureNotificationTables(client)
    return await getNotificationSummary({ executor: client, userId: input.userId })
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
    return await listOpenUserTasks({ executor: client, userId: input.userId })
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
    if (input.eventIds.length === 0) {
      await markAllNotificationsRead({ executor: client, userId: input.userId, readAt: nowIso() })
    } else {
      await markNotificationsRead({ executor: client, userId: input.userId, eventIds: input.eventIds, readAt: nowIso() })
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
  const client = getControlPlaneClient(input.env)
  try {
    await ensureNotificationTables(client)
    return await dismissUserTask({ executor: client, taskId: input.taskId, userId: input.userId, dismissedAt: nowIso() })
  } finally {
    client.close?.()
  }
}
