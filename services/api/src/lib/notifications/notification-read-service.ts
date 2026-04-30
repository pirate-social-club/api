import { nowIso } from "../helpers"
import { badRequestError } from "../errors"
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
  buildUniqueHumanTask,
  isSyntheticUniqueHumanTaskId,
  needsUniqueHumanTask,
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
import type { Env } from "../../types"

export async function getNotificationsSummary(input: {
  env: Env
  userId: string
}): Promise<NotificationSummary> {
  const client = getControlPlaneClient(input.env)
  try {
    await syncUserNotificationTasks(client, input.userId)
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
    await syncUserNotificationTasks(client, input.userId)

    const tasks = await listOpenUserTasks({ executor: client, userId: input.userId })
    const syntheticTasks: UserTask[] = []

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
  if (isSyntheticUniqueHumanTaskId(input.taskId)) {
    throw badRequestError("This task cannot be dismissed")
  }
  const client = getControlPlaneClient(input.env)
  try {
    return await dismissUserTask({ executor: client, taskId: input.taskId, userId: input.userId, dismissedAt: nowIso() })
  } finally {
    client.close?.()
  }
}
