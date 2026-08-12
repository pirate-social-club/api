import { nowIso } from "../helpers"
import { decodePublicId } from "../public-ids"
import { getControlPlaneClient } from "../runtime-deps"
import {
  dismissUserTask,
  listOpenUserTasks,
} from "./notification-task-store"
import {
  getNotificationSummary,
  listNotificationFeed,
  markAllNotificationsRead,
  markNotificationsRead,
} from "./notification-read-store"
import {
  syncUserNotificationTasks,
  UNIQUE_HUMAN_TASK_TYPE,
} from "./notification-user-task-sync"
import { trackNotificationMarkedReadSafely } from "./notification-tracking"
import type {
  NotificationFeedResponse,
  NotificationSummary,
  NotificationTasksResponse,
  UserTask,
} from "../../types"
import type { Env } from "../../env"

export async function getNotificationsSummary(input: {
  env: Env
  userId: string
}): Promise<NotificationSummary> {
  const client = getControlPlaneClient(input.env)
  try {
    await syncUserNotificationTasks(client, input.userId)
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
    await syncUserNotificationTasks(client, input.userId)

    const tasks = await listOpenUserTasks({ executor: client, userId: input.userId })

    return {
      items: tasks.items.filter((task) => task.type !== UNIQUE_HUMAN_TASK_TYPE),
      next_cursor: tasks.next_cursor ?? null,
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
    const eventIds = input.eventIds.map((eventId) => decodePublicId(eventId, "ne"))
    const countsByType = input.eventIds.length === 0
      ? await markAllNotificationsRead({ executor: client, userId: input.userId, readAt: nowIso() })
      : await markNotificationsRead({ executor: client, userId: input.userId, eventIds, readAt: nowIso() })
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
}): Promise<{ task: UserTask; wasDismissed: boolean } | null> {
  const taskId = decodePublicId(input.taskId, "task")
  const client = getControlPlaneClient(input.env)
  try {
    return await dismissUserTask({ executor: client, taskId, userId: input.userId, dismissedAt: nowIso() })
  } finally {
    client.close?.()
  }
}
