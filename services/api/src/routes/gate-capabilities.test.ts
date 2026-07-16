import { afterEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import type { Env } from "../env"
import { errorResponse } from "../lib/errors"
import gateCapabilities, { resetGateCapabilityRateLimitForTests } from "./gate-capabilities"

afterEach(() => resetGateCapabilityRateLimitForTests())

function app() {
  const app = new Hono<{ Bindings: Env }>()
  app.onError((error, c) => {
    const response = errorResponse(error)
    return c.json(response.body, response.status as 400)
  })
  app.route("/gate-capabilities", gateCapabilities)
  return app
}

const adminEnv = { PIRATE_ADMIN_TOKEN: "admin-secret" } as Env
const adminHeaders = {
  "x-admin-token": "admin-secret",
  "x-admin-as-user-id": "usr_test",
}

describe("gate capability routes", () => {
  test("requires authentication", async () => {
    const response = await app().request("/gate-capabilities/nft/sources", {}, adminEnv)
    expect(response.status).toBe(401)
  })

  test("lists stable trusted sources for an authenticated actor", async () => {
    const response = await app().request("/gate-capabilities/nft/sources", { headers: adminHeaders }, adminEnv)
    expect(response.status).toBe(200)
    const body = await response.json() as { sources: Array<{ id: string }> }
    expect(body.sources.map(({ id }) => id)).toEqual([
      "courtyard-graded-cards-ethereum",
      "courtyard-watches-ethereum",
      "courtyard-graded-cards-polygon",
      "courtyard-watches-polygon",
    ])
  })

  test("rejects unknown sources and invalid bounds before calling Courtyard", async () => {
    const missing = await app().request("/gate-capabilities/nft/sources/unknown/facets/subject/values", { headers: adminHeaders }, adminEnv)
    expect(missing.status).toBe(404)

    const invalidLimit = await app().request("/gate-capabilities/nft/sources/courtyard-graded-cards-ethereum/facets/subject/values?limit=51", { headers: adminHeaders }, adminEnv)
    expect(invalidLimit.status).toBe(400)
  })
})
