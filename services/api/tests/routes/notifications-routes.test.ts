import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../../src/index"
import {
  createNamespaceVerificationTask,
  emitPostCommented,
} from "../../src/lib/notifications/notification-service"
import { createRouteTestContext, json, resetRuntimeCaches } from "../helpers"
import { exchangeJwt } from "./community-routes-test-helpers"

let cleanup: (() => Promise<void>) | null = null

beforeEach(() => {
  resetRuntimeCaches()
})

afterEach(async () => {
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

function authHeaders(accessToken: string): { authorization: string } {
  return { authorization: `Bearer ${accessToken}` }
}

describe("notification routes", () => {
  test("requires authentication", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const response = await app.request("http://pirate.test/notifications/summary", {}, ctx.env)
    expect(response.status).toBe(401)
    const body = await json(response) as { code: string }
    expect(body.code).toBe("auth_error")
  })

  test("reads tasks and activity, then marks and dismisses them", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "notification-route-user")

    const task = await createNamespaceVerificationTask({
      env: ctx.env,
      userId: session.userId,
      communityId: "cmt_notifications",
      communityDisplayName: "Notifications",
    })

    await emitPostCommented({
      env: ctx.env,
      actorUserId: "usr_notification_actor",
      postAuthorUserId: session.userId,
      communityId: "cmt_notifications",
      commentExcerpt: "A direct route notification",
      postTitle: "Notification Route",
      postId: "pst_notifications",
      commentId: "cmt_notifications_reply",
    })

    const summary = await app.request(
      "http://pirate.test/notifications/summary",
      { headers: authHeaders(session.accessToken) },
      ctx.env,
    )
    expect(summary.status).toBe(200)
    const summaryBody = await json(summary) as {
      open_task_count: number
      unread_activity_count: number
      has_unread: boolean
    }
    expect(summaryBody).toEqual({
      open_task_count: 1,
      unread_activity_count: 1,
      has_unread: true,
    })

    const tasks = await app.request(
      "http://pirate.test/notifications/tasks",
      { headers: authHeaders(session.accessToken) },
      ctx.env,
    )
    expect(tasks.status).toBe(200)
    const tasksBody = await json(tasks) as { items: Array<{ task_id: string; status: string }> }
    expect(tasksBody.items).toHaveLength(1)
    expect(tasksBody.items[0]).toMatchObject({ task_id: task.task_id, status: "open" })

    const feed = await app.request(
      "http://pirate.test/notifications/feed?limit=1",
      { headers: authHeaders(session.accessToken) },
      ctx.env,
    )
    expect(feed.status).toBe(200)
    const feedBody = await json(feed) as {
      items: Array<{
        event: { event_id: string; type: string; payload: Record<string, unknown> | null }
        receipt: { read_at: string | null }
      }>
      next_cursor: string | null
    }
    expect(feedBody.items).toHaveLength(1)
    expect(feedBody.next_cursor).toBeNull()
    expect(feedBody.items[0]?.event.type).toBe("post_commented")
    expect(feedBody.items[0]?.event.payload?.post_title).toBe("Notification Route")
    expect(feedBody.items[0]?.receipt.read_at).toBeNull()

    const eventId = feedBody.items[0]!.event.event_id
    const markRead = await app.request(
      "http://pirate.test/notifications/mark-read",
      {
        method: "POST",
        headers: {
          ...authHeaders(session.accessToken),
          "content-type": "application/json",
        },
        body: JSON.stringify({ event_ids: [eventId] }),
      },
      ctx.env,
    )
    expect(markRead.status).toBe(200)
    expect(await json(markRead)).toEqual({ ok: true })

    const summaryAfterRead = await app.request(
      "http://pirate.test/notifications/summary",
      { headers: authHeaders(session.accessToken) },
      ctx.env,
    )
    const summaryAfterReadBody = await json(summaryAfterRead) as {
      open_task_count: number
      unread_activity_count: number
      has_unread: boolean
    }
    expect(summaryAfterReadBody).toEqual({
      open_task_count: 1,
      unread_activity_count: 0,
      has_unread: true,
    })

    const dismiss = await app.request(
      "http://pirate.test/notifications/dismiss-task",
      {
        method: "POST",
        headers: {
          ...authHeaders(session.accessToken),
          "content-type": "application/json",
        },
        body: JSON.stringify({ task_id: task.task_id }),
      },
      ctx.env,
    )
    expect(dismiss.status).toBe(200)
    const dismissBody = await json(dismiss) as { task_id: string; status: string }
    expect(dismissBody).toMatchObject({ task_id: task.task_id, status: "dismissed" })

    const tasksAfterDismiss = await app.request(
      "http://pirate.test/notifications/tasks",
      { headers: authHeaders(session.accessToken) },
      ctx.env,
    )
    const tasksAfterDismissBody = await json(tasksAfterDismiss) as { items: unknown[] }
    expect(tasksAfterDismissBody.items).toEqual([])
  })
})
