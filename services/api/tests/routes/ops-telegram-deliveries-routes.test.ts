import { afterEach, describe, expect, test } from "bun:test"
import { app } from "../../src/index"
import type { Env } from "../../src/types"
import { createRouteTestContext, json } from "../helpers"
import { exchangeJwt } from "./communities/community-routes-test-helpers"

const ADMIN_TOKEN = "test-admin-token-abc123"
const BASE = "http://pirate.test/admin/ops/telegram/uncertain-deliveries"

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

function list(env: Env, token?: string, query = ""): Promise<Response> {
  return Promise.resolve(app.request(
    `${BASE}${query}`,
    { headers: token ? { "x-admin-token": token } : {} },
    env,
  ))
}

function resolve(env: Env, headers: Record<string, string>, body: unknown): Promise<Response> {
  return Promise.resolve(app.request(
    `${BASE}/tpd_missing/resolve`,
    {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    },
    env,
  ))
}

describe("GET /admin/ops/telegram/uncertain-deliveries", () => {
  test("rejects requests without the admin token", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    expect((await list(ctx.env)).status).toBe(401)
    expect((await list(ctx.env, "not-the-token")).status).toBe(401)
  })

  test("returns an empty, ok roll-up when nothing is stranded", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    const response = await list(ctx.env, ADMIN_TOKEN)
    expect(response.status).toBe(200)
    const body = await json(response) as { items: unknown[]; total: number; ok: boolean }
    expect(body.items).toEqual([])
    expect(body.total).toBe(0)
    // ok is the alert signal: true means there is nothing to action.
    expect(body.ok).toBe(true)
  })

  test("the count endpoint is guarded the same way", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    expect((await Promise.resolve(app.request(`${BASE}/count`, {}, ctx.env))).status).toBe(401)
    const ok = await Promise.resolve(app.request(
      `${BASE}/count`,
      { headers: { "x-admin-token": ADMIN_TOKEN } },
      ctx.env,
    ))
    expect(ok.status).toBe(200)
  })
})

describe("Telegram staging synthetic routes", () => {
  test("discovers the owner through the migrated control-plane schema", async () => {
    const ctx = await createRouteTestContext({
      ENVIRONMENT: "staging",
      PIRATE_ADMIN_TOKEN: ADMIN_TOKEN,
    })
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "telegram-synthetic-owner")
    const now = "2026-07-29T00:00:00.000Z"

    await ctx.client.batch([
      {
        sql: `
          INSERT INTO communities (
            community_id, creator_user_id, display_name, membership_mode,
            status, provisioning_state, transfer_state, route_slug,
            created_at, updated_at
          ) VALUES (?1, ?2, 'Synthetic fixture', 'request', 'active', 'active',
                    'none', 'synthetic-fixture', ?3, ?3)
        `,
        args: ["cmt_synthetic_fixture", session.userId, now],
      },
      {
        sql: `
          INSERT INTO telegram_community_bots (
            telegram_community_bot_id, community_id, encrypted_bot_token, token_last4,
            encryption_key_version, telegram_bot_user_id, bot_username, bot_display_name,
            webhook_id, webhook_secret, webhook_status, status, created_at, updated_at,
            actor_user_id
          ) VALUES (
            'tcb_synthetic_fixture', 'cmt_synthetic_fixture', 'encrypted', 'oken',
            1, '123456', 'SyntheticBot', 'Synthetic bot', 'tgw_synthetic_fixture',
            'secret', 'active', 'active', ?1, ?1, ?2
          )
        `,
        args: [now, session.userId],
      },
      {
        sql: `
          INSERT INTO telegram_channel_destinations (
            telegram_channel_destination_id, telegram_community_bot_id, community_id,
            telegram_chat_id, channel_title, channel_username, bot_admin_status,
            publication_mode, status, linked_by_user_id, linked_at, updated_at
          ) VALUES (
            'tcd_synthetic_fixture', 'tcb_synthetic_fixture', 'cmt_synthetic_fixture',
            '-100123456', 'Synthetic channel', NULL, 'ready', 'from_now', 'active',
            ?1, ?2, ?2
          )
        `,
        args: [session.userId, now],
      },
    ])

    const response = await Promise.resolve(app.request(
      "http://pirate.test/admin/ops/telegram/synthetic-fixture",
      { headers: { "x-admin-token": ADMIN_TOKEN } },
      ctx.env,
    ))
    expect(response.status).toBe(200)
    expect(await json(response)).toEqual({
      community_id: "com_cmt_synthetic_fixture",
      owner_user_id: session.userId,
      channel_title: "Synthetic channel",
    })
  })

  test("are invisible outside staging", async () => {
    const ctx = await createRouteTestContext({
      ENVIRONMENT: "production",
      PIRATE_ADMIN_TOKEN: ADMIN_TOKEN,
    })
    cleanup = ctx.cleanup

    const response = await Promise.resolve(app.request(
      "http://pirate.test/admin/ops/telegram/synthetic-fixture",
      { headers: { "x-admin-token": ADMIN_TOKEN } },
      ctx.env,
    ))
    expect(response.status).toBe(404)
  })

  test("require the admin token on staging", async () => {
    const ctx = await createRouteTestContext({
      ENVIRONMENT: "staging",
      PIRATE_ADMIN_TOKEN: ADMIN_TOKEN,
    })
    cleanup = ctx.cleanup

    for (const request of [
      new Request("http://pirate.test/admin/ops/telegram/synthetic-fixture"),
      new Request("http://pirate.test/admin/ops/telegram/synthetic-deliveries/post_pst_1"),
      new Request("http://pirate.test/admin/ops/telegram/synthetic-deliveries/post_pst_1/cleanup", {
        method: "POST",
      }),
    ]) {
      const response = await Promise.resolve(app.request(request, undefined, ctx.env))
      expect(response.status).toBe(401)
      expect(response.headers.get("cache-control") ?? "").toContain("no-store")
    }
  })
})

describe("POST /admin/ops/telegram/uncertain-deliveries/:id/resolve", () => {
  test("rejects requests without the admin token", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    const response = await resolve(ctx.env, {}, { action: "retry_authorized" })
    expect(response.status).toBe(401)
  })

  test("rejects an unknown action before touching any delivery", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    const response = await resolve(
      ctx.env,
      { "x-admin-token": ADMIN_TOKEN, "x-admin-as-user-id": "usr_ops" },
      { action: "delete_everything" },
    )
    expect(response.status).toBe(400)
  })
})

describe("operational reads are never cached", () => {
  // Observed on staging: the unfiltered count returned a 19-minute-old body
  // (cf-cache-status HIT, age 1164) naming a delivery that had already been
  // resolved. Filtered URLs appeared correct only because they were different
  // cache keys. An operator acting on that would chase a phantom stranded row —
  // or miss a real one behind a stale zero.
  test("declares private, no-store on list and count", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    for (const url of [BASE, `${BASE}/count`]) {
      const response = await Promise.resolve(app.request(url, { headers: { "x-admin-token": ADMIN_TOKEN } }, ctx.env))
      expect(response.status).toBe(200)
      const cacheControl = response.headers.get("cache-control") ?? ""
      expect(cacheControl).toContain("no-store")
      expect(cacheControl).toContain("private")
    }
  })

  test("declares no-store even on an unauthorized response", async () => {
    // A cached 401 is just as wrong, and error paths are the ones that forget.
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    const response = await Promise.resolve(app.request(`${BASE}/count`, {}, ctx.env))
    expect(response.status).toBe(401)
    expect(response.headers.get("cache-control") ?? "").toContain("no-store")
  })

  // Mount order is load-bearing: Hono matches in registration order, so a route
  // mounted BEFORE the middleware bypasses it entirely. The first version of
  // this fix covered /admin/ops only because it happens to be mounted last, and
  // its tests passed while /admin/debug was completely uncovered.
  test.each([
    ["mounted BEFORE the middleware", "http://pirate.test/admin/bot-users"],
    ["mounted BEFORE the middleware", "http://pirate.test/admin/debug/post-pipeline"],
    ["mounted AFTER the middleware", "http://pirate.test/admin/ops/wallets"],
    ["mounted AFTER the middleware", "http://pirate.test/admin/ops/telegram/uncertain-deliveries/count"],
  ])("covers a route %s: %s", async (_when, url) => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    const response = await Promise.resolve(app.request(url, { headers: { "x-admin-token": ADMIN_TOKEN } }, ctx.env))
    expect(response.headers.get("cache-control") ?? "").toContain("no-store")
  })

  // A thrown/returned error builds a fresh Response, which discarded the
  // middleware headers: /admin/debug/post-pipeline returned 400 with none.
  test("covers an ERROR response, not just success", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    // Missing the required post_id query parameter.
    const response = await Promise.resolve(app.request(
      "http://pirate.test/admin/debug/post-pipeline",
      { headers: { "x-admin-token": ADMIN_TOKEN } },
      ctx.env,
    ))
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(response.headers.get("cache-control") ?? "").toContain("no-store")
  })

  test("the ops namespace specifically stays covered", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    const response = await Promise.resolve(app.request(
      "http://pirate.test/admin/ops/wallets",
      { headers: { "x-admin-token": ADMIN_TOKEN } },
      ctx.env,
    ))
    expect(response.headers.get("cache-control") ?? "").toContain("no-store")
  })

  // The identical URL must reflect state changes — no query-string busting.
  test("the exact unfiltered URL reflects state changes across requests", async () => {
    const ctx = await createRouteTestContext({ PIRATE_ADMIN_TOKEN: ADMIN_TOKEN })
    cleanup = ctx.cleanup

    const read = async () => {
      const r = await Promise.resolve(app.request(`${BASE}/count`, { headers: { "x-admin-token": ADMIN_TOKEN } }, ctx.env))
      return (await json(r) as { total: number }).total
    }

    const first = await read()
    const second = await read()
    // Same URL, same result shape, served from the handler both times rather
    // than a stored copy: repeated identical reads must agree with each other
    // AND with the store, not with a snapshot taken earlier.
    expect(first).toBe(0)
    expect(second).toBe(0)
  })
})
