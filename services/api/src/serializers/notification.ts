import type {
  NotificationFeedResponse,
  NotificationSummary,
  NotificationTasksResponse,
  UserTask,
} from "../types"

export function serializeNotificationSummary(summary: NotificationSummary): NotificationSummary {
  return summary
}

export function serializeNotificationTasks(tasks: NotificationTasksResponse): NotificationTasksResponse {
  return tasks
}

export function serializeNotificationFeed(feed: NotificationFeedResponse): NotificationFeedResponse {
  return feed
}

export function serializeUserTask(task: UserTask): UserTask {
  return task
}
