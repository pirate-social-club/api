import { afterEach, describe, expect, test } from "bun:test"
import {
  buildAnalyticsEvent,
  enqueueAnalyticsEvent,
  flushAnalyticsOutbox,
  hmacUserId,
  isAnalyticsEnabled,
} from "../src/lib/analytics"
import { app } from "../src/index"
import { buildTestEnv, createControlPlaneTestClient, withMockedFetch } from "./helpers"

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe("analytics outbox", () => {
  test("hashes user ids with the configured HMAC secret", async () => {
    const env = buildTestEnv({ ANALYTICS_HMAC_SECRET: "analytics-secret" })
    const first = await hmacUserId(env, "usr_test")
    const second = await hmacUserId(env, "usr_test")
    const different = await hmacUserId(env, "usr_other")

    expect(first).toBe(second)
    expect(first).toMatch(/^[a-f0-9]{64}$/)
    expect(first).not.toBe(different)
  })

  test("analytics is opt-in outside production and defaults on in production", () => {
    expect(isAnalyticsEnabled(buildTestEnv())).toBe(false)
    expect(isAnalyticsEnabled(buildTestEnv({ ANALYTICS_ENABLED: "true" }))).toBe(true)
    expect(isAnalyticsEnabled(buildTestEnv({ ANALYTICS_ENABLED: "1" }))).toBe(true)
    expect(isAnalyticsEnabled(buildTestEnv({ ENVIRONMENT: "production" }))).toBe(true)
    expect(isAnalyticsEnabled(buildTestEnv({ ENVIRONMENT: "production", ANALYTICS_ENABLED: "false" }))).toBe(false)
  })

  test("queues dedupable raw events", async () => {
    const setup = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanup = setup.cleanup
    const env = buildTestEnv({
      ANALYTICS_HMAC_SECRET: "analytics-secret",
      ENVIRONMENT: "staging",
    })
    const event = await buildAnalyticsEvent(env, {
      eventId: "evt_test_analytics_01",
      eventName: "post_created",
      eventTime: "2026-04-20T12:00:00.000Z",
      source: "api",
      appSurface: "api",
      userId: "usr_test",
      communityId: "cmt_test",
      postId: "pst_test",
      requestId: "req_test",
      properties: { post_type: "text" },
    })

    await enqueueAnalyticsEvent(setup.client, event)
    await enqueueAnalyticsEvent(setup.client, event)

    const result = await setup.client.execute({
      sql: "SELECT analytics_event_id, event_name, environment, user_id_hash, properties_json, status FROM analytics_outbox",
      args: [],
    })

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]?.analytics_event_id).toBe("evt_test_analytics_01")
    expect(result.rows[0]?.event_name).toBe("post_created")
    expect(result.rows[0]?.environment).toBe("staging")
    expect(String(result.rows[0]?.user_id_hash)).toMatch(/^[a-f0-9]{64}$/)
    expect(result.rows[0]?.properties_json).toBe(JSON.stringify({ post_type: "text" }))
    expect(result.rows[0]?.status).toBe("pending")
  })

  test("marks sending events failed when Tinybird fetch throws", async () => {
    const setup = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanup = setup.cleanup
    const env = buildTestEnv({
      ANALYTICS_ENABLED: "true",
      ANALYTICS_HMAC_SECRET: "analytics-secret",
      TINYBIRD_INGEST_TOKEN: "tb_test",
    })
    const event = await buildAnalyticsEvent(env, {
      eventId: "evt_test_analytics_fetch_error",
      eventName: "post_created",
      source: "api",
      appSurface: "api",
      userId: "usr_test",
    })
    await enqueueAnalyticsEvent(setup.client, event)

    await withMockedFetch(() => (() => {
      throw new Error("network_down")
    }) as typeof fetch, async () => {
      const result = await flushAnalyticsOutbox(env, setup.client)
      expect(result).toEqual({ attempted: 1, sent: 0, failed: 1 })
    })

    const row = await setup.client.execute({
      sql: "SELECT status, attempt_count, last_error FROM analytics_outbox WHERE analytics_event_id = ?1",
      args: [event.event_id],
    })
    expect(row.rows[0]?.status).toBe("failed")
    expect(row.rows[0]?.attempt_count).toBe(1)
    expect(String(row.rows[0]?.last_error)).toContain("network_down")
  })

  test("accepts allowlisted client events through the API proxy", async () => {
    const setup = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanup = setup.cleanup
    const env = buildTestEnv({
      DEV_MEMORY_STORE_ENABLED: "false",
      CONTROL_PLANE_DATABASE_URL: `file:${setup.databasePath}`,
      ANALYTICS_ENABLED: "true",
      ANALYTICS_HMAC_SECRET: "analytics-secret",
      ENVIRONMENT: "staging",
    })

    const response = await app.request("http://pirate.test/analytics/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_id: "evt_client_page_viewed",
        event_name: "page_viewed",
        anonymous_id: "anon_test",
        properties: {
          pathname: "/c/infinity",
          reddit_username: "should_not_leave_api",
        },
      }),
    }, env)

    expect(response.status).toBe(202)
    const result = await setup.client.execute({
      sql: "SELECT event_name, source, app_surface, anonymous_id, properties_json FROM analytics_outbox WHERE analytics_event_id = ?1",
      args: ["evt_client_page_viewed"],
    })
    expect(result.rows[0]?.event_name).toBe("page_viewed")
    expect(result.rows[0]?.source).toBe("web")
    expect(result.rows[0]?.app_surface).toBe("web")
    expect(result.rows[0]?.anonymous_id).toBe("anon_test")
    expect(result.rows[0]?.properties_json).toBe(JSON.stringify({ pathname: "/c/infinity" }))
  })
})
