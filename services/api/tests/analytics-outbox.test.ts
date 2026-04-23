import { afterEach, describe, expect, test } from "bun:test"
import {
  buildAnalyticsEvent,
  enqueueAnalyticsEvent,
  hmacUserId,
  isAnalyticsEnabled,
} from "../src/lib/analytics"
import { buildTestEnv, createControlPlaneTestClient } from "./helpers"

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

  test("analytics is opt-in", () => {
    expect(isAnalyticsEnabled(buildTestEnv())).toBe(false)
    expect(isAnalyticsEnabled(buildTestEnv({ ANALYTICS_ENABLED: "true" }))).toBe(true)
    expect(isAnalyticsEnabled(buildTestEnv({ ANALYTICS_ENABLED: "1" }))).toBe(true)
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
})

