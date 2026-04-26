import { Hono } from "hono"
import { badRequestError } from "../lib/errors"
import { trackApiEvent } from "../lib/analytics/track"
import { authenticate, type AuthenticatedEnv } from "../lib/auth-middleware"
import {
  getNotificationsSummary,
  getNotificationsTasks,
  getNotificationsFeed,
  markRead,
  dismissTask,
} from "../lib/notifications/notification-service"

const notifications = new Hono<AuthenticatedEnv>()

notifications.use("*", authenticate)

notifications.get("/summary", async (c) => {
  const actor = c.get("actor")
  const summary = await getNotificationsSummary({ env: c.env, userId: actor.userId })
  return c.json(summary)
})

notifications.get("/tasks", async (c) => {
  const actor = c.get("actor")
  const tasks = await getNotificationsTasks({ env: c.env, userId: actor.userId })
  return c.json(tasks)
})

notifications.get("/feed", async (c) => {
  const actor = c.get("actor")
  const cursor = c.req.query("cursor") ?? null
  const limitRaw = Number(c.req.query("limit") ?? "")
  const limit = Number.isFinite(limitRaw) ? Math.min(100, Math.max(1, Math.trunc(limitRaw))) : 25

  const feed = await getNotificationsFeed({
    env: c.env,
    userId: actor.userId,
    cursor,
    limit,
  })
  return c.json(feed)
})

notifications.post("/mark-read", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ event_ids?: string[] }>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid payload")
  }

  await markRead({
    env: c.env,
    userId: actor.userId,
    eventIds: body.event_ids ?? [],
  })
  return c.json({ ok: true })
})

notifications.post("/dismiss-task", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ task_id?: string }>().catch(() => null)
  if (!body?.task_id) {
    throw badRequestError("task_id is required")
  }

  const task = await dismissTask({
    env: c.env,
    userId: actor.userId,
    taskId: body.task_id,
  })

  if (!task) {
    throw badRequestError("Task not found or already dismissed")
  }

  await trackApiEvent(c.env, c.req, {
    eventName: "notification_task_dismissed",
    userId: actor.userId,
    properties: {
      notification_kind: "task",
      task_type: task.type,
      task_persistence: "persisted",
      dismiss_surface: "inbox",
    },
  })

  return c.json(task)
})

export default notifications
