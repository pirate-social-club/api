import { afterEach, describe, expect, test } from "bun:test"
import { app } from "../../src/index"
import { buildTestEnv, createControlPlaneTestClient, json } from "../helpers"

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe("analytics routes", () => {
  test("client analytics route queues allowlisted events", async () => {
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
      headers: {
        "content-type": "application/json",
        "x-pirate-session-id": "ses_route_test",
        "x-pirate-anonymous-id": "anon_header",
      },
      body: JSON.stringify({
        event_id: "evt_route_page_viewed",
        event_name: "page_viewed",
        anonymous_id: "anon_body",
        properties: {
          pathname: "/c/infinity",
          reddit_username: "should_not_leave_api",
        },
      }),
    }, env)

    expect(response.status).toBe(202)
    expect(await json(response)).toEqual({ accepted: true })

    const result = await setup.client.execute({
      sql: `
        SELECT event_name, source, app_surface, session_id, anonymous_id, properties_json
        FROM analytics_outbox
        WHERE analytics_event_id = ?1
      `,
      args: ["evt_route_page_viewed"],
    })

    expect(result.rows[0]?.event_name).toBe("page_viewed")
    expect(result.rows[0]?.source).toBe("web")
    expect(result.rows[0]?.app_surface).toBe("web")
    expect(result.rows[0]?.session_id).toBe("ses_route_test")
    expect(result.rows[0]?.anonymous_id).toBe("anon_body")
    expect(result.rows[0]?.properties_json).toBe(JSON.stringify({ pathname: "/c/infinity" }))
  })

  test("client analytics route rejects unsupported events", async () => {
    const response = await app.request("http://pirate.test/analytics/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_name: "post_created",
      }),
    }, buildTestEnv())

    expect(response.status).toBe(400)
    const body = await json(response) as { code: string; message: string }
    expect(body.code).toBe("bad_request")
    expect(body.message).toBe("Unsupported analytics event")
  })

  test("client analytics route stores community ids for community views", async () => {
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
        event_id: "evt_route_community_viewed",
        event_name: "community_viewed",
        community_id: "cmt_route_community",
        properties: {
          tab: "posts",
        },
      }),
    }, env)

    expect(response.status).toBe(202)

    const result = await setup.client.execute({
      sql: `
        SELECT event_name, community_id, properties_json
        FROM analytics_outbox
        WHERE analytics_event_id = ?1
      `,
      args: ["evt_route_community_viewed"],
    })

    expect(result.rows[0]?.event_name).toBe("community_viewed")
    expect(result.rows[0]?.community_id).toBe("cmt_route_community")
    expect(result.rows[0]?.properties_json).toBe(JSON.stringify({ tab: "posts" }))
  })

  test("client analytics route queues community follow contract drift signals", async () => {
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
        event_id: "evt_route_follow_contract_drift",
        event_name: "community_follow_contract_drift",
        community_id: "cmt_route_community",
        properties: {
          action: "follow",
          drift_kind: "missing_community",
          expected_community_id: "com_cmt_route_community",
          ignored: "not_allowed",
        },
      }),
    }, env)

    expect(response.status).toBe(202)

    const result = await setup.client.execute({
      sql: `
        SELECT event_name, community_id, properties_json
        FROM analytics_outbox
        WHERE analytics_event_id = ?1
      `,
      args: ["evt_route_follow_contract_drift"],
    })

    expect(result.rows[0]?.event_name).toBe("community_follow_contract_drift")
    expect(result.rows[0]?.community_id).toBe("cmt_route_community")
    expect(result.rows[0]?.properties_json).toBe(JSON.stringify({
      action: "follow",
      drift_kind: "missing_community",
      expected_community_id: "com_cmt_route_community",
    }))
  })

  test("client analytics route canonicalizes community route slugs for community views", async () => {
    const setup = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanup = setup.cleanup
    const env = buildTestEnv({
      DEV_MEMORY_STORE_ENABLED: "false",
      CONTROL_PLANE_DATABASE_URL: `file:${setup.databasePath}`,
      ANALYTICS_ENABLED: "true",
      ANALYTICS_HMAC_SECRET: "analytics-secret",
      ENVIRONMENT: "staging",
    })

    await setup.client.execute({
      sql: `
        INSERT INTO users (
          user_id,
          primary_wallet_attachment_id,
          verification_state,
          capability_provider,
          verification_capabilities_json,
          verified_at,
          current_verification_session_id,
          created_at,
          updated_at
        ) VALUES (?1, NULL, 'verified', NULL, '{}', NULL, NULL, ?2, ?2)
      `,
      args: ["usr_route_creator", "2026-05-04T00:00:00.000Z"],
    })
    await setup.client.execute({
      sql: `
        INSERT INTO communities (
          community_id,
          creator_user_id,
          display_name,
          membership_mode,
          status,
          provisioning_state,
          transfer_state,
          route_slug,
          namespace_verification_id,
          pending_namespace_verification_session_id,
          created_at,
          updated_at
        ) VALUES (?1, ?2, ?3, 'request', 'active', 'active', 'none', ?4, NULL, NULL, ?5, ?5)
      `,
      args: [
        "cmt_route_canonical",
        "usr_route_creator",
        "Route Canonical",
        "route-canonical",
        "2026-05-04T00:00:00.000Z",
      ],
    })

    const response = await app.request("http://pirate.test/analytics/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_id: "evt_route_slug_community_viewed",
        event_name: "community_viewed",
        community_id: "route-canonical",
      }),
    }, env)

    expect(response.status).toBe(202)

    const result = await setup.client.execute({
      sql: "SELECT community_id FROM analytics_outbox WHERE analytics_event_id = ?1",
      args: ["evt_route_slug_community_viewed"],
    })

    expect(result.rows[0]?.community_id).toBe("cmt_route_canonical")
  })

  test("client analytics route queues production events when analytics flag is unset", async () => {
    const setup = await createControlPlaneTestClient({ includeAllMigrations: true })
    cleanup = setup.cleanup
    const env = buildTestEnv({
      DEV_MEMORY_STORE_ENABLED: "false",
      CONTROL_PLANE_DATABASE_URL: `file:${setup.databasePath}`,
      ANALYTICS_HMAC_SECRET: "analytics-secret",
      ENVIRONMENT: "production",
    })

    const response = await app.request("http://pirate.test/analytics/events", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        event_id: "evt_route_prod_default",
        event_name: "community_viewed",
        community_id: "cmt_route_community",
      }),
    }, env)

    expect(response.status).toBe(202)

    const result = await setup.client.execute({
      sql: "SELECT event_name, community_id FROM analytics_outbox WHERE analytics_event_id = ?1",
      args: ["evt_route_prod_default"],
    })

    expect(result.rows[0]?.event_name).toBe("community_viewed")
    expect(result.rows[0]?.community_id).toBe("cmt_route_community")
  })

  test("client analytics route queues PWA install funnel events", async () => {
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
        event_id: "evt_route_pwa_install_viewed",
        event_name: "pwa_install_promo_viewed",
        properties: {
          surface: "inbox",
          trigger: "unread_count",
          unread_count_bucket: "2_5",
          raw_user_agent: "should_not_leave_api",
        },
      }),
    }, env)

    expect(response.status).toBe(202)

    const result = await setup.client.execute({
      sql: `
        SELECT event_name, properties_json
        FROM analytics_outbox
        WHERE analytics_event_id = ?1
      `,
      args: ["evt_route_pwa_install_viewed"],
    })

    expect(result.rows[0]?.event_name).toBe("pwa_install_promo_viewed")
    expect(result.rows[0]?.properties_json).toBe(JSON.stringify({
      surface: "inbox",
      trigger: "unread_count",
      unread_count_bucket: "2_5",
    }))
  })

  test("client analytics route preserves allowlisted notification properties", async () => {
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
        event_id: "evt_route_notification_opened",
        event_name: "notification_opened",
        properties: {
          notification_kind: "task",
          notification_type: "membership_review",
          task_type: "membership_review",
          task_persistence: "persisted",
          open_surface: "inbox",
          task_auto_cleared_on_open: true,
          unsupported_key: "drop-me",
        },
      }),
    }, env)

    expect(response.status).toBe(202)

    const result = await setup.client.execute({
      sql: `
        SELECT event_name, properties_json
        FROM analytics_outbox
        WHERE analytics_event_id = ?1
      `,
      args: ["evt_route_notification_opened"],
    })

    expect(result.rows[0]?.event_name).toBe("notification_opened")
    expect(result.rows[0]?.properties_json).toBe(JSON.stringify({
      notification_kind: "task",
      notification_type: "membership_review",
      task_type: "membership_review",
      task_persistence: "persisted",
      open_surface: "inbox",
      task_auto_cleared_on_open: true,
    }))
  })

  test("client analytics route preserves allowlisted notification read properties", async () => {
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
        event_id: "evt_route_notification_marked_read",
        event_name: "notification_marked_read",
        properties: {
          notification_kind: "activity",
          notification_type: "post_commented",
          read_mode: "auto_visible_load",
          open_surface: "inbox",
          count: 2,
          unsupported_key: "drop-me",
        },
      }),
    }, env)

    expect(response.status).toBe(202)

    const result = await setup.client.execute({
      sql: `
        SELECT event_name, properties_json
        FROM analytics_outbox
        WHERE analytics_event_id = ?1
      `,
      args: ["evt_route_notification_marked_read"],
    })

    expect(result.rows[0]?.event_name).toBe("notification_marked_read")
    expect(result.rows[0]?.properties_json).toBe(JSON.stringify({
      notification_kind: "activity",
      notification_type: "post_commented",
      read_mode: "auto_visible_load",
      open_surface: "inbox",
      count: 2,
    }))
  })
})
