import { afterEach, describe, expect, test } from "bun:test"

import { app } from "../../../src/index"
import { createRouteTestContext } from "../../helpers"
import { exchangeJwt } from "./community-routes-test-helpers"

type RouteTestContext = Awaited<ReturnType<typeof createRouteTestContext>>

let cleanup: RouteTestContext["cleanup"] | null = null

afterEach(async () => {
  await cleanup?.()
  cleanup = null
})

describe("removed community booking routes", () => {
  test("returns 404 while canonical global booking routes remain authoritative", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const actor = await exchangeJwt(ctx.env, "removed-community-bookings")
    const headers = { authorization: `Bearer ${actor.accessToken}` }

    const requests = [
      app.request("http://pirate.test/communities/com_removed/bookings", { headers }, ctx.env),
      app.request("http://pirate.test/communities/com_removed/booking-hosts/usr_host/holds", {
        method: "POST",
        headers,
      }, ctx.env),
      app.request("http://pirate.test/communities/com_removed/bookings/bkg_removed/complete", {
        method: "POST",
        headers,
      }, ctx.env),
    ]

    const responses = await Promise.all(requests)
    expect(responses.map((response) => response.status)).toEqual([404, 404, 404])
  })
})
