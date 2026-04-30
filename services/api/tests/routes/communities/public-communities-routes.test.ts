import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app } from "../../../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
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

describe("public community routes", () => {
  test("community search requires a non-empty query", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const response = await app.request("http://pirate.test/public-communities?query=", {}, ctx.env)
    expect(response.status).toBe(400)
    const body = await json(response) as { message: string }
    expect(body.message).toBe("query must be at least 2 characters")
  })

  test("community search resolves active communities by display name even when route_slug is missing", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "public-community-search-user")

    await ctx.client.execute({
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
          primary_database_binding_id,
          created_at,
          updated_at
        ) VALUES
          (?1, ?2, ?3, 'open', 'active', 'active', 'none', NULL, NULL, NULL, NULL, ?4, ?4),
          (?5, ?2, ?6, 'open', 'active', 'active', 'none', ?7, NULL, NULL, NULL, ?8, ?8),
          (?9, ?2, ?10, 'open', 'draft', 'requested', 'none', NULL, NULL, NULL, NULL, ?11, ?11)
      `,
      args: [
        "cmt_infinity",
        session.userId,
        "Infinity",
        "2026-04-20T00:00:00.000Z",
        "cmt_infinite_loop",
        "Infinite Loop",
        "infinite-loop",
        "2026-04-20T00:01:00.000Z",
        "cmt_hidden",
        "Infinity Draft",
        "2026-04-20T00:02:00.000Z",
      ],
    })

    const response = await app.request("http://pirate.test/public-communities?query=infinity", {}, ctx.env)
    expect(response.status).toBe(200)
    const body = await json(response) as {
      query: string | null
      communities: Array<{
        community_id: string
        display_name: string
        route_slug: string | null
      }>
    }

    expect(body.query).toBe("infinity")
    expect(body.communities).toEqual([
      {
        community_id: "cmt_infinity",
        display_name: "Infinity",
        route_slug: null,
      },
    ])
  })
})
