import { nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import { resolveUserTask, upsertUserTask } from "./notification-task-store"
import { trackNotificationGeneratedSafely } from "./notification-tracking"
import type { Env, UserTask } from "../../types"

export async function createNamespaceVerificationTask(input: {
  env: Env
  userId: string
  communityId: string
  communityDisplayName: string
}): Promise<UserTask> {
  const client = getControlPlaneClient(input.env)
  try {
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
