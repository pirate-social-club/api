import { afterEach, describe, expect, test } from "bun:test"
import { app } from "../../src/index"
import type { Env } from "../../src/types"
import { createRouteTestContext, json } from "../helpers"

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
