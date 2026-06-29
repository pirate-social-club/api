import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test"
import { app } from "../../src/index"
import { json, resetRuntimeCaches, createRouteTestContext } from "../helpers"
import { exchangeJwt } from "./communities/community-routes-test-helpers"

type Ctx = Awaited<ReturnType<typeof createRouteTestContext>>

setDefaultTimeout(20_000)

let cleanup: (() => Promise<void>) | null = null

beforeEach(() => {
  resetRuntimeCaches()
})
afterEach(async () => {
  if (cleanup) { await cleanup(); cleanup = null }
})

async function setup(): Promise<{ ctx: Ctx; accessToken: string; userId: string }> {
  const ctx = await createRouteTestContext()
  cleanup = ctx.cleanup
  const { accessToken, userId } = await exchangeJwt(ctx.env, "host-authoring-test")
  return { ctx, accessToken, userId }
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

function jsonHeaders(token: string): Record<string, string> {
  return { ...authHeaders(token), "content-type": "application/json" }
}

async function getProfile(env: Ctx["env"], token: string) {
  return app.request("http://pirate.test/host-bookings/me/profile", {
    headers: authHeaders(token),
  }, env)
}

async function postProfile(env: Ctx["env"], token: string, body: Record<string, unknown>) {
  return app.request("http://pirate.test/host-bookings/me/profile", {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify(body),
  }, env)
}

async function postAction(env: Ctx["env"], token: string, action: string) {
  return app.request(`http://pirate.test/host-bookings/me/profile/${action}`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: "{}",
  }, env)
}

async function postRule(env: Ctx["env"], token: string, body: Record<string, unknown>) {
  return app.request("http://pirate.test/host-bookings/me/availability-rules", {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify(body),
  }, env)
}

async function updateRule(env: Ctx["env"], token: string, id: string, body: Record<string, unknown>) {
  return app.request(`http://pirate.test/host-bookings/me/availability-rules/${id}`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify(body),
  }, env)
}

async function deleteRule(env: Ctx["env"], token: string, id: string) {
  return app.request(`http://pirate.test/host-bookings/me/availability-rules/${id}`, {
    method: "DELETE",
    headers: authHeaders(token),
  }, env)
}

async function listRules(env: Ctx["env"], token: string) {
  return app.request("http://pirate.test/host-bookings/me/availability-rules", {
    headers: authHeaders(token),
  }, env)
}

async function postException(env: Ctx["env"], token: string, body: Record<string, unknown>) {
  return app.request("http://pirate.test/host-bookings/me/availability-exceptions", {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify(body),
  }, env)
}

async function deleteException(env: Ctx["env"], token: string, id: string) {
  return app.request(`http://pirate.test/host-bookings/me/availability-exceptions/${id}`, {
    method: "DELETE",
    headers: authHeaders(token),
  }, env)
}

async function updateException(env: Ctx["env"], token: string, id: string, body: Record<string, unknown>) {
  return app.request(`http://pirate.test/host-bookings/me/availability-exceptions/${id}`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify(body),
  }, env)
}

async function postPriceRule(env: Ctx["env"], token: string, body: Record<string, unknown>) {
  return app.request("http://pirate.test/host-bookings/me/price-rules", {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify(body),
  }, env)
}

async function deletePriceRule(env: Ctx["env"], token: string, id: string) {
  return app.request(`http://pirate.test/host-bookings/me/price-rules/${id}`, {
    method: "DELETE",
    headers: authHeaders(token),
  }, env)
}

async function updatePriceRule(env: Ctx["env"], token: string, id: string, body: Record<string, unknown>) {
  return app.request(`http://pirate.test/host-bookings/me/price-rules/${id}`, {
    method: "POST",
    headers: jsonHeaders(token),
    body: JSON.stringify(body),
  }, env)
}

const VALID_PROFILE = {
  host_timezone: "Europe/Vienna",
  base_price_cents: 5000,
  default_slot_duration_seconds: 1800,
  payout_wallet_address: "0x1111111111111111111111111111111111111111",
}

describe("host-bookings — auth", () => {
  test("rejects requests without a token", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const res = await app.request("http://pirate.test/host-bookings/me/profile", {}, ctx.env)
    expect(res.status).toBe(401)
  })
})

describe("host-bookings — profile", () => {
  test("GET returns exists:false when no profile", async () => {
    const { ctx, accessToken } = await setup()
    const res = await getProfile(ctx.env, accessToken)
    expect(res.status).toBe(200)
    const body = await json(res) as { object: string; exists: boolean; host: string }
    expect(body.object).toBe("booking_profile")
    expect(body.exists).toBe(false)
  })

  test("POST creates a profile and returns 201", async () => {
    const { ctx, accessToken } = await setup()
    const res = await postProfile(ctx.env, accessToken, VALID_PROFILE)
    expect(res.status).toBe(201)
    const body = await json(res) as Record<string, unknown>
    expect(body.object).toBe("booking_profile")
    expect(body.is_published).toBe(false)
    expect(body.host_timezone).toBe("Europe/Vienna")
    expect(body.base_price_cents).toBe(5000)
  })

  test("POST with missing required fields on first create returns 400", async () => {
    const { ctx, accessToken } = await setup()
    const res = await postProfile(ctx.env, accessToken, { host_timezone: "UTC" })
    expect(res.status).toBe(400)
    const body = await json(res) as { error: string; fields: Array<{ field: string }> }
    expect(body.error).toBe("missing_required_fields")
    expect(body.fields.map((f) => f.field)).toContain("base_price_cents")
  })

  test("POST partial update on existing profile returns 200", async () => {
    const { ctx, accessToken } = await setup()
    await postProfile(ctx.env, accessToken, VALID_PROFILE)
    const res = await postProfile(ctx.env, accessToken, { bio: "Updated bio" })
    expect(res.status).toBe(200)
    const body = await json(res) as { bio: string }
    expect(body.bio).toBe("Updated bio")
  })

  test("POST rejects malformed optional profile fields", async () => {
    const { ctx, accessToken } = await setup()
    await postProfile(ctx.env, accessToken, VALID_PROFILE)
    const res = await postProfile(ctx.env, accessToken, {
      display_headline: 42,
      bio: false,
      topics: "guitar",
      intro_video_ref: {},
    })
    expect(res.status).toBe(400)
    const body = await json(res) as { error: string; fields: Array<{ field: string }> }
    expect(body.error).toBe("validation_failed")
    expect(body.fields.map((f) => f.field)).toEqual([
      "display_headline",
      "bio",
      "intro_video_ref",
      "topics",
    ])
  })

  test("publish sets is_published to true", async () => {
    const { ctx, accessToken } = await setup()
    await postProfile(ctx.env, accessToken, VALID_PROFILE)
    const res = await postAction(ctx.env, accessToken, "publish")
    expect(res.status).toBe(200)
    const body = await json(res) as { is_published: boolean }
    expect(body.is_published).toBe(true)
  })

  test("publish without a payout wallet is blocked (409)", async () => {
    const { ctx, accessToken } = await setup()
    const { payout_wallet_address, ...noPayout } = VALID_PROFILE
    await postProfile(ctx.env, accessToken, noPayout)
    const res = await postAction(ctx.env, accessToken, "publish")
    expect(res.status).toBe(409)
    expect((await json(res) as { error: string }).error).toBe("payout_wallet_required")
  })

  test("POST rejects an invalid payout wallet address (400)", async () => {
    const { ctx, accessToken } = await setup()
    await postProfile(ctx.env, accessToken, VALID_PROFILE)
    const res = await postProfile(ctx.env, accessToken, { payout_wallet_address: "not-an-address" })
    expect(res.status).toBe(400)
    const body = await json(res) as { error: string; fields: Array<{ field: string }> }
    expect(body.error).toBe("validation_failed")
    expect(body.fields.map((f) => f.field)).toContain("payout_wallet_address")
  })

  test("unpublish sets is_published to false", async () => {
    const { ctx, accessToken } = await setup()
    await postProfile(ctx.env, accessToken, VALID_PROFILE)
    await postAction(ctx.env, accessToken, "publish")
    const res = await postAction(ctx.env, accessToken, "unpublish")
    expect(res.status).toBe(200)
    const body = await json(res) as { is_published: boolean }
    expect(body.is_published).toBe(false)
  })

  test("publish without a profile returns 409", async () => {
    const { ctx, accessToken } = await setup()
    const res = await postAction(ctx.env, accessToken, "publish")
    expect(res.status).toBe(409)
  })

  test("timestamps are Unix seconds, not ISO", async () => {
    const { ctx, accessToken } = await setup()
    await postProfile(ctx.env, accessToken, VALID_PROFILE)
    const res = await getProfile(ctx.env, accessToken)
    const body = await json(res) as { created: number; updated: number }
    expect(typeof body.created).toBe("number")
    expect(body.created).toBeGreaterThan(0)
    expect(String(body.created).length).toBeLessThanOrEqual(10)
  })

  test("host field is present, not host_user_id", async () => {
    const { ctx, accessToken } = await setup()
    await postProfile(ctx.env, accessToken, VALID_PROFILE)
    const res = await getProfile(ctx.env, accessToken)
    const body = await json(res) as Record<string, unknown>
    expect(body.host).toBeDefined()
    expect(body.host_user_id).toBeUndefined()
  })
})

describe("host-bookings — availability rules", () => {
  test("create + list + update + delete", async () => {
    const { ctx, accessToken } = await setup()
    await postProfile(ctx.env, accessToken, VALID_PROFILE)

    const createRes = await postRule(ctx.env, accessToken, {
      by_weekday: [1, 2, 3, 4, 5],
      start_local: "09:00",
      end_local: "17:00",
      slot_duration_seconds: 1800,
    })
    expect(createRes.status).toBe(201)
    const created = await json(createRes) as { id: string; object: string; by_weekday: number[] }
    expect(created.object).toBe("availability_rule")
    expect(created.id).toMatch(/^bar_/)
    expect(created.by_weekday).toEqual([1, 2, 3, 4, 5])

    const listRes = await listRules(ctx.env, accessToken)
    expect(listRes.status).toBe(200)
    const listBody = await json(listRes) as { object: string; data: unknown[] }
    expect(listBody.object).toBe("list")
    expect(listBody.data).toHaveLength(1)

    const updateRes = await updateRule(ctx.env, accessToken, created.id, {
      end_local: "18:00",
    })
    expect(updateRes.status).toBe(200)
    const updated = await json(updateRes) as { end_local: string }
    expect(updated.end_local).toBe("18:00")

    const delRes = await deleteRule(ctx.env, accessToken, created.id)
    expect(delRes.status).toBe(200)
    const delBody = await json(delRes) as { id: string; deleted: boolean; object: string }
    expect(delBody.deleted).toBe(true)
    expect(delBody.object).toBe("availability_rule")
  })

  test("create without a profile returns 409", async () => {
    const { ctx, accessToken } = await setup()
    const res = await postRule(ctx.env, accessToken, {
      by_weekday: [1],
      start_local: "09:00",
      end_local: "17:00",
      slot_duration_seconds: 1800,
    })
    expect(res.status).toBe(409)
    const body = await json(res) as { error: string }
    expect(body.error).toBe("profile_not_found")
  })

  test("create with invalid data returns 400 with fields", async () => {
    const { ctx, accessToken } = await setup()
    await postProfile(ctx.env, accessToken, VALID_PROFILE)
    const res = await postRule(ctx.env, accessToken, {
      by_weekday: [8],
      start_local: "bad",
      end_local: "25:00",
      slot_duration_seconds: 0,
    })
    expect(res.status).toBe(400)
    const body = await json(res) as { error: string; fields: Array<{ field: string }> }
    expect(body.error).toBe("validation_failed")
    expect(body.fields.length).toBeGreaterThanOrEqual(3)
  })

  test("delete non-existent rule returns 404", async () => {
    const { ctx, accessToken } = await setup()
    await postProfile(ctx.env, accessToken, VALID_PROFILE)
    const res = await deleteRule(ctx.env, accessToken, "bar_nonexistent")
    expect(res.status).toBe(404)
  })

  test("update non-existent rule returns 404", async () => {
    const { ctx, accessToken } = await setup()
    await postProfile(ctx.env, accessToken, VALID_PROFILE)
    const res = await updateRule(ctx.env, accessToken, "bar_nonexistent", { start_local: "10:00" })
    expect(res.status).toBe(404)
  })

  test("server-generated id, client-supplied id ignored", async () => {
    const { ctx, accessToken } = await setup()
    await postProfile(ctx.env, accessToken, VALID_PROFILE)
    const res = await postRule(ctx.env, accessToken, {
      id: "client_supplied_id",
      by_weekday: [1],
      start_local: "09:00",
      end_local: "17:00",
      slot_duration_seconds: 1800,
    })
    expect(res.status).toBe(201)
    const body = await json(res) as { id: string }
    expect(body.id).toMatch(/^bar_/)
    expect(body.id).not.toBe("client_supplied_id")
  })
})

describe("host-bookings — availability exceptions", () => {
  test("create + list + delete", async () => {
    const { ctx, accessToken } = await setup()
    await postProfile(ctx.env, accessToken, VALID_PROFILE)

    const res = await postException(ctx.env, accessToken, {
      kind: "block",
      start_utc: "2026-07-04T00:00:00Z",
      end_utc: "2026-07-04T23:59:59Z",
    })
    expect(res.status).toBe(201)
    const body = await json(res) as { id: string; object: string; kind: string; start: number; end: number }
    expect(body.object).toBe("availability_exception")
    expect(body.id).toMatch(/^bae_/)
    expect(body.kind).toBe("block")
    expect(typeof body.start).toBe("number")
    expect(typeof body.end).toBe("number")
  })

  test("create with end <= start returns 400", async () => {
    const { ctx, accessToken } = await setup()
    await postProfile(ctx.env, accessToken, VALID_PROFILE)
    const res = await postException(ctx.env, accessToken, {
      kind: "block",
      start_utc: "2026-07-04T12:00:00Z",
      end_utc: "2026-07-04T10:00:00Z",
    })
    expect(res.status).toBe(400)
  })

  test("delete returns deleted-resource shape", async () => {
    const { ctx, accessToken } = await setup()
    await postProfile(ctx.env, accessToken, VALID_PROFILE)
    const createRes = await postException(ctx.env, accessToken, {
      kind: "block",
      start_utc: "2026-07-04T00:00:00Z",
      end_utc: "2026-07-04T23:59:59Z",
    })
    const created = await json(createRes) as { id: string }
    const delRes = await deleteException(ctx.env, accessToken, created.id)
    expect(delRes.status).toBe(200)
    const delBody = await json(delRes) as { id: string; deleted: boolean; object: string }
    expect(delBody.deleted).toBe(true)
    expect(delBody.object).toBe("availability_exception")
  })

  test("empty update is an idempotent no-op", async () => {
    const { ctx, accessToken } = await setup()
    await postProfile(ctx.env, accessToken, VALID_PROFILE)
    const createRes = await postException(ctx.env, accessToken, {
      kind: "open",
      start_utc: "2026-07-05T00:00:00Z",
      end_utc: "2026-07-05T01:00:00Z",
    })
    const created = await json(createRes) as { id: string; kind: string; start: number; end: number }

    const updateRes = await updateException(ctx.env, accessToken, created.id, {})
    expect(updateRes.status).toBe(200)
    const updated = await json(updateRes) as { id: string; kind: string; start: number; end: number }
    expect(updated.id).toBe(created.id)
    expect(updated.kind).toBe(created.kind)
    expect(updated.start).toBe(created.start)
    expect(updated.end).toBe(created.end)
  })
})

describe("host-bookings — price rules", () => {
  test("create with priority default 0", async () => {
    const { ctx, accessToken } = await setup()
    await postProfile(ctx.env, accessToken, VALID_PROFILE)

    const res = await postPriceRule(ctx.env, accessToken, {
      price_cents: 6000,
    })
    expect(res.status).toBe(201)
    const body = await json(res) as { id: string; object: string; price_cents: number; priority: number }
    expect(body.object).toBe("price_rule")
    expect(body.id).toMatch(/^bprl_/)
    expect(body.price_cents).toBe(6000)
    expect(body.priority).toBe(0)
  })

  test("create with explicit priority", async () => {
    const { ctx, accessToken } = await setup()
    await postProfile(ctx.env, accessToken, VALID_PROFILE)

    const res = await postPriceRule(ctx.env, accessToken, {
      match_weekday: [1, 2, 3],
      match_local_start: "18:00",
      match_local_end: "20:00",
      price_cents: 8000,
      priority: 10,
    })
    expect(res.status).toBe(201)
    const body = await json(res) as { priority: number; match_weekday: number[] }
    expect(body.priority).toBe(10)
    expect(body.match_weekday).toEqual([1, 2, 3])
  })

  test("create rejects non-integer priority", async () => {
    const { ctx, accessToken } = await setup()
    await postProfile(ctx.env, accessToken, VALID_PROFILE)

    const res = await postPriceRule(ctx.env, accessToken, {
      price_cents: 8000,
      priority: "10",
    })
    expect(res.status).toBe(400)
    const body = await json(res) as { error: string; fields: Array<{ field: string }> }
    expect(body.error).toBe("validation_failed")
    expect(body.fields).toEqual([{ field: "priority", reason: "must be an integer" }])
  })

  test("update rejects non-integer priority", async () => {
    const { ctx, accessToken } = await setup()
    await postProfile(ctx.env, accessToken, VALID_PROFILE)
    const createRes = await postPriceRule(ctx.env, accessToken, { price_cents: 5000 })
    const created = await json(createRes) as { id: string }

    const res = await updatePriceRule(ctx.env, accessToken, created.id, { priority: 1.5 })
    expect(res.status).toBe(400)
    const body = await json(res) as { error: string; fields: Array<{ field: string }> }
    expect(body.error).toBe("validation_failed")
    expect(body.fields).toEqual([{ field: "priority", reason: "must be an integer" }])
  })

  test("create with zero price returns 400", async () => {
    const { ctx, accessToken } = await setup()
    await postProfile(ctx.env, accessToken, VALID_PROFILE)
    const res = await postPriceRule(ctx.env, accessToken, { price_cents: 0 })
    expect(res.status).toBe(400)
  })

  test("delete returns deleted-resource shape", async () => {
    const { ctx, accessToken } = await setup()
    await postProfile(ctx.env, accessToken, VALID_PROFILE)
    const createRes = await postPriceRule(ctx.env, accessToken, { price_cents: 5000 })
    const created = await json(createRes) as { id: string }
    const delRes = await deletePriceRule(ctx.env, accessToken, created.id)
    expect(delRes.status).toBe(200)
    const delBody = await json(delRes) as { id: string; deleted: boolean; object: string }
    expect(delBody.deleted).toBe(true)
    expect(delBody.object).toBe("price_rule")
  })
})
