import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../../src/index"
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

describe("feed routes", () => {
  test("GET /feed/home returns an empty feed with active community summaries", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "feed-route-creator")

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
          (?1, ?2, ?3, 'open', 'active', 'active', 'none', ?4, NULL, NULL, NULL, ?5, ?5),
          (?6, ?2, ?7, 'open', 'draft', 'requested', 'none', ?8, NULL, NULL, NULL, ?9, ?9)
      `,
      args: [
        "cmt_feed_active",
        session.userId,
        "Feed Active",
        "feed-active",
        "2026-04-21T00:00:00.000Z",
        "cmt_feed_draft",
        "Feed Draft",
        "feed-draft",
        "2026-04-21T00:01:00.000Z",
      ],
    })

    const response = await app.request("http://pirate.test/feed/home?sort=new&time_range=all", {}, ctx.env)
    expect(response.status).toBe(200)
    const body = await json(response) as {
      items: unknown[]
      top_communities: Array<{
        community_id: string
        display_name: string
        route_slug: string | null
      }>
      next_cursor: string | null
    }

    expect(body.items).toEqual([])
    expect(body.next_cursor).toBeNull()
    expect(body.top_communities).toHaveLength(1)
    expect(body.top_communities[0]).toMatchObject({
      community_id: "cmt_feed_active",
      display_name: "Feed Active",
      route_slug: "feed-active",
    })
  })
})
