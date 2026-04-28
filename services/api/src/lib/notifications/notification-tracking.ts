import { trackServerEvent } from "../analytics"
import type { DbExecutor } from "../db-helpers"
import type { Env } from "../../types"

type NotificationGeneratedInput = {
  userId: string
  notificationType: string
  notificationKind: "task" | "activity"
  communityId?: string | null
  postId?: string | null
  commentId?: string | null
  taskType?: string | null
  taskPersistence?: "persisted" | "synthetic" | null
}

async function trackNotificationGenerated(
  env: Env,
  executor: DbExecutor,
  input: NotificationGeneratedInput,
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

export async function trackNotificationGeneratedSafely(
  env: Env,
  executor: DbExecutor,
  input: NotificationGeneratedInput,
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

export async function trackNotificationMarkedReadSafely(
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
