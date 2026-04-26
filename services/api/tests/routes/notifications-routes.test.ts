import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../../src/index"
import {
  createNamespaceVerificationTask,
  emitRoyaltyEarnedBatch,
  emitPostCommented,
} from "../../src/lib/notifications/notification-service"
import { createRouteTestContext, json, resetRuntimeCaches } from "../helpers"
import { exchangeJwt } from "./communities/community-routes-test-helpers"

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

  test("rejects dismissing synthetic tasks", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "notification-synthetic-dismiss-user")

    const response = await app.request(
      "http://pirate.test/notifications/dismiss-task",
      {
        method: "POST",
        headers: {
          ...authHeaders(session.accessToken),
          "content-type": "application/json",
        },
        body: JSON.stringify({ task_id: `synth:unique_human:${session.userId}` }),
      },
      ctx.env,
    )

    expect(response.status).toBe(400)
    const body = await json(response) as { code: string; message: string }
    expect(body.code).toBe("bad_request")
    expect(body.message).toBe("This task cannot be dismissed")
  })

  test("reads tasks and activity, then marks and dismisses them", async () => {
    const ctx = await createRouteTestContext({
      ANALYTICS_ENABLED: "true",
      ANALYTICS_HMAC_SECRET: "analytics-secret",
    })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "notification-route-user")
    const actorSession = await exchangeJwt(ctx.env, "notification-route-actor")
    await ctx.client.execute({
      sql: `
        UPDATE profiles
        SET display_name = ?2,
            avatar_ref = ?3
        WHERE user_id = ?1
      `,
      args: [actorSession.userId, "Route Actor", "/avatars/route-actor.png"],
    })

    const task = await createNamespaceVerificationTask({
      env: ctx.env,
      userId: session.userId,
      communityId: "cmt_notifications",
      communityDisplayName: "Notifications",
    })

    await emitPostCommented({
      env: ctx.env,
      actorUserId: actorSession.userId,
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
      open_task_count: 4,
      unread_activity_count: 1,
      has_unread: true,
    })

    const tasks = await app.request(
      "http://pirate.test/notifications/tasks",
      { headers: authHeaders(session.accessToken) },
      ctx.env,
    )
    expect(tasks.status).toBe(200)
    const tasksBody = await json(tasks) as {
      items: Array<{ task_id: string; type: string; status: string; payload?: Record<string, unknown> | null }>
    }
    expect(tasksBody.items).toHaveLength(4)
    expect(tasksBody.items.some((item) => item.task_id === task.task_id && item.status === "open")).toBe(true)
    expect(tasksBody.items.find((item) => item.task_id === task.task_id)).toMatchObject({
      payload: {
        target_path: "/c/cmt_notifications/mod/namespace",
      },
    })
    expect(tasksBody.items.find((item) => item.type === "global_handle_cleanup_suggested")).toMatchObject({
      payload: {
        target_path: "/settings/profile",
      },
    })

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
    expect(feedBody.items[0]?.event.payload?.actor_display_name).toBe("Route Actor")
    expect(feedBody.items[0]?.event.payload?.actor_avatar_url).toBe("/avatars/route-actor.png")
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
      open_task_count: 4,
      unread_activity_count: 0,
      has_unread: true,
    })

    const readAnalyticsAfterFirstMark = await ctx.client.execute({
      sql: `
        SELECT event_name, properties_json
        FROM analytics_outbox
        WHERE event_name = 'notification_marked_read'
        ORDER BY created_at ASC
      `,
      args: [],
    })
    expect(readAnalyticsAfterFirstMark.rows).toHaveLength(1)
    expect(readAnalyticsAfterFirstMark.rows[0]?.properties_json).toBe(JSON.stringify({
      notification_kind: "activity",
      notification_type: "post_commented",
      read_mode: "explicit_ids",
      open_surface: "inbox",
      count: 1,
    }))

    const markReadAgain = await app.request(
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
    expect(markReadAgain.status).toBe(200)

    const readAnalyticsAfterRepeat = await ctx.client.execute({
      sql: `
        SELECT COUNT(*) AS cnt
        FROM analytics_outbox
        WHERE event_name = 'notification_marked_read'
      `,
      args: [],
    })
    expect(Number(readAnalyticsAfterRepeat.rows[0]?.cnt ?? 0)).toBe(1)

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
    const tasksAfterDismissBody = await json(tasksAfterDismiss) as { items: Array<{ task_id: string }> }
    expect(tasksAfterDismissBody.items.some((item) => item.task_id === task.task_id)).toBe(false)

    const analyticsRows = await ctx.client.execute({
      sql: `
        SELECT event_name, properties_json
        FROM analytics_outbox
        WHERE event_name IN ('notification_generated', 'notification_task_dismissed')
        ORDER BY created_at ASC
      `,
      args: [],
    })
    expect(analyticsRows.rows).toHaveLength(3)
    expect(analyticsRows.rows.map((row) => row.event_name)).toEqual([
      "notification_generated",
      "notification_generated",
      "notification_task_dismissed",
    ])
    expect(analyticsRows.rows[0]?.properties_json).toBe(JSON.stringify({
      notification_kind: "task",
      notification_type: "namespace_verification_required",
      task_type: "namespace_verification_required",
      task_persistence: "persisted",
    }))
    expect(analyticsRows.rows[1]?.properties_json).toBe(JSON.stringify({
      notification_kind: "activity",
      notification_type: "post_commented",
      task_type: null,
      task_persistence: null,
    }))
    expect(analyticsRows.rows[2]?.properties_json).toBe(JSON.stringify({
      notification_kind: "task",
      task_type: "namespace_verification_required",
      task_persistence: "persisted",
      dismiss_surface: "inbox",
    }))
  })

  test("lists royalty activity from persisted events without synthetic royalty tasks", async () => {
    const ctx = await createRouteTestContext({
      ANALYTICS_ENABLED: "true",
      ANALYTICS_HMAC_SECRET: "analytics-secret",
    })
    cleanup = ctx.cleanup
    const creatorSession = await exchangeJwt(ctx.env, "royalty-activity-creator")
    const buyerSession = await exchangeJwt(ctx.env, "royalty-activity-buyer")

    await emitPostCommented({
      env: ctx.env,
      actorUserId: buyerSession.userId,
      postAuthorUserId: creatorSession.userId,
      communityId: "cmt_royalty_activity",
      commentExcerpt: "Non-royalty notification",
      postTitle: "Plain Activity",
      postId: "pst_plain_activity",
      commentId: "cmt_plain_activity",
    })

    const earningEvent = {
      recipientUserId: creatorSession.userId,
      communityId: "cmt_royalty_activity",
      assetId: "ast_royalty_activity",
      storyIpId: "0x1111111111111111111111111111111111111111",
      amountWipWei: "12450000000000000000",
      buyerWalletAddress: "0x2222222222222222222222222222222222222222",
      txHash: "0x3333333333333333333333333333333333333333333333333333333333333333",
      purchaseId: "pur_royalty_activity",
      title: null,
    }

    await emitRoyaltyEarnedBatch({
      env: ctx.env,
      buyerUserId: buyerSession.userId,
      events: [earningEvent],
    })
    await emitRoyaltyEarnedBatch({
      env: ctx.env,
      buyerUserId: buyerSession.userId,
      events: [earningEvent],
    })
    await new Promise((resolve) => setTimeout(resolve, 2))
    await emitRoyaltyEarnedBatch({
      env: ctx.env,
      buyerUserId: buyerSession.userId,
      events: [{
        ...earningEvent,
        assetId: "ast_royalty_activity_second",
        amountWipWei: "4000000000000000000",
        purchaseId: "pur_royalty_activity_second",
      }],
    })
    await emitRoyaltyEarnedBatch({
      env: ctx.env,
      buyerUserId: buyerSession.userId,
      events: [{
        ...earningEvent,
        recipientUserId: buyerSession.userId,
        assetId: "ast_self_purchase",
        purchaseId: "pur_self_purchase",
      }],
    })

    const eventCount = await ctx.client.execute({
      sql: `SELECT COUNT(*) AS cnt FROM notification_events WHERE type = 'royalty_earned'`,
      args: [],
    })
    expect(Number(eventCount.rows[0]?.cnt ?? 0)).toBe(2)

    const analyticsCount = await ctx.client.execute({
      sql: `
        SELECT COUNT(*) AS cnt
        FROM analytics_outbox
        WHERE event_name = 'notification_generated'
          AND properties_json = ?1
      `,
      args: [JSON.stringify({
        notification_kind: "activity",
        notification_type: "royalty_earned",
        task_type: null,
        task_persistence: null,
      })],
    })
    expect(Number(analyticsCount.rows[0]?.cnt ?? 0)).toBe(2)

    const activity = await app.request(
      "http://pirate.test/royalties/activity?limit=1",
      { headers: authHeaders(creatorSession.accessToken) },
      ctx.env,
    )
    expect(activity.status).toBe(200)
    const activityBody = await json(activity) as {
      items: Array<{
        asset_id: string
        story_ip_id: string
        amount_wip_wei: string
        buyer_wallet_address: string | null
        purchase_id: string | null
      }>
      next_cursor: string | null
    }
    expect(activityBody.items).toHaveLength(1)
    expect(activityBody.next_cursor).not.toBeNull()

    const nextActivity = await app.request(
      `http://pirate.test/royalties/activity?limit=1&cursor=${encodeURIComponent(activityBody.next_cursor ?? "")}`,
      { headers: authHeaders(creatorSession.accessToken) },
      ctx.env,
    )
    expect(nextActivity.status).toBe(200)
    const nextActivityBody = await json(nextActivity) as typeof activityBody
    expect(nextActivityBody.items).toHaveLength(1)
    expect(nextActivityBody.next_cursor).toBeNull()
    const activityItems = [...activityBody.items, ...nextActivityBody.items]
    const firstEarning = activityItems.find((item) => item.asset_id === "ast_royalty_activity")
    expect(firstEarning).toMatchObject({
      asset_id: "ast_royalty_activity",
      story_ip_id: "0x1111111111111111111111111111111111111111",
      amount_wip_wei: "12450000000000000000",
      buyer_wallet_address: "0x2222222222222222222222222222222222222222",
      purchase_id: "pur_royalty_activity",
    })
    const secondEarning = activityItems.find((item) => item.asset_id === "ast_royalty_activity_second")
    expect(secondEarning).toMatchObject({
      asset_id: "ast_royalty_activity_second",
      amount_wip_wei: "4000000000000000000",
      purchase_id: "pur_royalty_activity_second",
    })

    const buyerActivity = await app.request(
      "http://pirate.test/royalties/activity?limit=10",
      { headers: authHeaders(buyerSession.accessToken) },
      ctx.env,
    )
    expect(buyerActivity.status).toBe(200)
    const buyerActivityBody = await json(buyerActivity) as { items: unknown[] }
    expect(buyerActivityBody.items).toHaveLength(0)

    const tasks = await app.request(
      "http://pirate.test/notifications/tasks",
      { headers: authHeaders(creatorSession.accessToken) },
      ctx.env,
    )
    expect(tasks.status).toBe(200)
    const tasksBody = await json(tasks) as { items: Array<{ type: string }> }
    expect(tasksBody.items.some((item) => item.type === "royalty_claim_available")).toBe(false)
  })

  test("mark all emits server-side read analytics bucketed by notification type", async () => {
    const ctx = await createRouteTestContext({
      ANALYTICS_ENABLED: "true",
      ANALYTICS_HMAC_SECRET: "analytics-secret",
    })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "notification-mark-all-user")
    const actorSession = await exchangeJwt(ctx.env, "notification-mark-all-actor")

    await emitPostCommented({
      env: ctx.env,
      actorUserId: actorSession.userId,
      postAuthorUserId: session.userId,
      communityId: "cmt_mark_all",
      commentExcerpt: "First unread item",
      postTitle: "Unread One",
      postId: "pst_mark_all_1",
      commentId: "cmt_mark_all_1",
    })
    await emitPostCommented({
      env: ctx.env,
      actorUserId: actorSession.userId,
      postAuthorUserId: session.userId,
      communityId: "cmt_mark_all",
      commentExcerpt: "Second unread item",
      postTitle: "Unread Two",
      postId: "pst_mark_all_2",
      commentId: "cmt_mark_all_2",
    })
    await emitRoyaltyEarnedBatch({
      env: ctx.env,
      buyerUserId: actorSession.userId,
      events: [{
        recipientUserId: session.userId,
        communityId: "cmt_mark_all",
        assetId: "ast_mark_all",
        storyIpId: "0x1111111111111111111111111111111111111111",
        amountWipWei: "1000000000000000000",
        buyerWalletAddress: "0x2222222222222222222222222222222222222222",
        txHash: "0x3333333333333333333333333333333333333333333333333333333333333333",
        purchaseId: "pur_mark_all",
        title: "Mark All Royalty",
      }],
    })

    const markAll = await app.request(
      "http://pirate.test/notifications/mark-read",
      {
        method: "POST",
        headers: {
          ...authHeaders(session.accessToken),
          "content-type": "application/json",
        },
        body: JSON.stringify({ event_ids: [] }),
      },
      ctx.env,
    )
    expect(markAll.status).toBe(200)

    const readAnalytics = await ctx.client.execute({
      sql: `
        SELECT properties_json
        FROM analytics_outbox
        WHERE event_name = 'notification_marked_read'
        ORDER BY created_at ASC
      `,
      args: [],
    })
    expect(readAnalytics.rows).toHaveLength(2)
    expect(readAnalytics.rows.map((row) => row.properties_json)).toEqual([
      JSON.stringify({
        notification_kind: "activity",
        notification_type: "post_commented",
        read_mode: "mark_all",
        open_surface: "inbox",
        count: 2,
      }),
      JSON.stringify({
        notification_kind: "activity",
        notification_type: "royalty_earned",
        read_mode: "mark_all",
        open_surface: "inbox",
        count: 1,
      }),
    ])
  })
})
