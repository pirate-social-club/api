import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import { app } from "../../../src/index"
import { buildLocalCommunityDbUrl } from "../../../src/lib/communities/community-local-db"
import publicReadApp from "../../../src/routes/public-read-app"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import { exchangeJwt, requestJson } from "./community-routes-test-helpers"

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
  test("serves a viewer-neutral community video feed and honors its surface policy", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "public-community-video-feed-owner")
    const create = await requestJson("http://pirate.test/communities", {
      display_name: "Video Feed Club",
      membership_mode: "request",
      handle_policy: { policy_template: "standard" },
    }, ctx.env, session.accessToken)
    expect(create.status).toBe(202)
    const communityId = ((await json(create)) as { community: { id: string } }).community.id

    const response = await app.request(
      `http://pirate.test/public-communities/${communityId}/feed/videos?sort=best`,
      {},
      ctx.env,
    )
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("cdn-cache-control")).toBe("no-store")
    expect(response.headers.get("cache-tag")).toBeNull()
    expect(response.headers.get("server-timing")).toContain("home-feed;dur=")
    expect(response.headers.get("vary")).toBeNull()
    expect(await json(response)).toEqual({
      items: [],
      top_communities: [],
      next_cursor: null,
    })

    const disable = await requestJson(
      `http://pirate.test/communities/${communityId}/presentation`,
      { video_feed_enabled: false },
      ctx.env,
      session.accessToken,
    )
    expect(disable.status).toBe(200)

    const disabled = await app.request(
      `http://pirate.test/public-communities/${communityId}/feed/videos`,
      {},
      ctx.env,
    )
    expect(disabled.status).toBe(403)
    expect(await json(disabled)).toMatchObject({
      code: "structured_surface_disabled",
      details: {
        community: communityId,
        reason: "community_opt_out",
        surface: "video_feed",
      },
    })
  })

  test("returns not found for a punycode handle missing the @ prefix", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const response = await publicReadApp.request(
      "http://pirate.test/public-communities/xn--tl8h",
      {},
      ctx.env,
    )

    expect(response.status).toBe(404)
  })

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
    const create = await requestJson("http://pirate.test/communities", {
      display_name: "Infinity",
      membership_mode: "request",
    }, ctx.env, session.accessToken)
    expect(create.status).toBe(202)
    const created = await json(create) as { community: { id: string; route_slug: string | null } }
    expect(created.community.route_slug).toBeNull()

    const response = await app.request("http://pirate.test/public-communities?query=infinity", {}, ctx.env)
    expect(response.status).toBe(200)
    const body = await json(response) as {
      query: string | null
      communities: Array<{
        community: string
        display_name: string
        route_slug: string | null
        membership_mode: string
        guest_comment_policy: string
        agent_posting_policy: string
        agent_posting_scope: string
        accepted_agent_ownership_providers: string[]
        membership_gate_summaries: Array<{ gate_type: string }>
      }>
    }

    expect(body.query).toBe("infinity")
    expect(body.communities).toHaveLength(1)
    expect(body.communities[0]).toMatchObject({
      community: created.community.id,
      display_name: "Infinity",
      route_slug: null,
      membership_mode: "request",
      guest_comment_policy: "disallow",
      agent_posting_policy: "disallow",
      agent_posting_scope: "replies_only",
      agent_daily_post_cap: null,
      agent_daily_reply_cap: null,
      accepted_agent_ownership_providers: ["clawkey"],
      membership_gate_summaries: [],
    })
  })

  test("community search propagates local preview schema drift instead of returning default policy fields", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "public-community-search-schema-drift")
    const create = await requestJson("http://pirate.test/communities", {
      display_name: "Search Schema Drift Club",
      membership_mode: "request",
    }, ctx.env, session.accessToken)
    expect(create.status).toBe(202)
    const body = await json(create) as { community: { id: string } }
    const communityId = body.community.id.replace(/^com_/, "")
    const local = createClient({
      url: buildLocalCommunityDbUrl(String(ctx.env.LOCAL_COMMUNITY_DB_ROOT ?? ""), communityId),
    })
    try {
      await local.execute("ALTER TABLE communities DROP COLUMN karaoke_enabled")
    } finally {
      local.close()
    }

    const response = await app.request(
      "http://pirate.test/public-communities?query=Search%20Schema%20Drift",
      {},
      ctx.env,
    )
    expect(response.status).toBe(500)
    expect(await json(response)).toMatchObject({ code: "internal_error" })
  })

  test("public community capabilities returns an action matrix for agent and guest writes", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "public-community-capabilities-user")
    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Capabilities Club",
      membership_mode: "request",
      allow_anonymous_identity: true,
      anonymous_identity_scope: "community_stable",
      guest_comment_policy: "altcha_required",
      agent_posting_policy: "allow",
      agent_posting_scope: "top_level_and_replies",
      agent_daily_post_cap: 5,
      agent_daily_reply_cap: 20,
      accepted_agent_ownership_providers: ["clawkey"],
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: { id: string }
    }

    const response = await app.request(
      `http://pirate.test/public-communities/${communityCreateBody.community.id}/capabilities`,
      {},
      ctx.env,
    )
    expect(response.status).toBe(200)
    const body = await json(response) as {
      community: string
      display_name: string
      read: {
        public_threads: { allowed: boolean }
      }
      write: {
        guest_comment: { allowed: boolean; requires: string[]; hint: string | null }
        guest_top_level_post: { allowed: boolean; blocked_reason: string | null }
        delegated_agent_reply: { allowed: boolean; accepted_ownership_providers: string[] }
        delegated_agent_top_level_post: { allowed: boolean; accepted_ownership_providers: string[] }
        user_vote: { allowed: boolean; auth: string; requires: string[]; hint: string | null }
      }
      raw_policy: {
        guest_comment_policy: string
        agent_posting_policy: string
        agent_posting_scope: string
      }
    }

    expect(body.community).toBe(communityCreateBody.community.id)
    expect(body.display_name).toBe("Capabilities Club")
    expect(body.read.public_threads.allowed).toBe(true)
    expect(body.write.guest_comment).toMatchObject({
      allowed: true,
      requires: ["altcha"],
    })
    expect(body.write.guest_comment.hint).toContain("prepare_guest_comment")
    expect(body.write.guest_top_level_post).toMatchObject({
      allowed: false,
      blocked_reason: "guest_top_level_posts_not_supported",
    })
    expect(body.write.delegated_agent_reply).toMatchObject({
      allowed: true,
      accepted_ownership_providers: ["clawkey"],
    })
    expect(body.write.delegated_agent_top_level_post).toMatchObject({
      allowed: true,
      accepted_ownership_providers: ["clawkey"],
    })
    expect(body.write.user_vote).toMatchObject({
      allowed: true,
      auth: "user_bearer",
      requires: ["altcha"],
    })
    expect(body.write.user_vote.hint).toContain("solve ALTCHA")
    expect(body.raw_policy).toMatchObject({
      guest_comment_policy: "altcha_required",
      agent_posting_policy: "allow",
      agent_posting_scope: "top_level_and_replies",
    })
  })

  test("does not cache a public preview when its owner summary is unavailable", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "public-community-missing-owner-summary-user")
    const create = await requestJson("http://pirate.test/communities", {
      display_name: "Owner Summary Retry Club",
      membership_mode: "request",
      handle_policy: { policy_template: "standard" },
    }, ctx.env, session.accessToken)
    expect(create.status).toBe(202)
    const communityId = ((await json(create)) as { community: { id: string } }).community.id

    // The community and its owner role remain valid. Removing only the public
    // profile linkage simulates the control-plane summary lookup returning no
    // row after the shard preview has otherwise completed successfully.
    await ctx.client.execute({
      sql: "UPDATE profiles SET global_handle_id = NULL WHERE user_id = ?1",
      args: [session.userId],
    })

    const response = await app.request(
      `http://pirate.test/public-communities/${communityId}`,
      {},
      ctx.env,
    )
    expect(response.status).toBe(200)
    expect((await json(response) as { owner: unknown }).owner).toBeNull()
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("cdn-cache-control")).toBe("no-store")
  })

  test("archived community is hidden from the public single-community preview, restored on unarchive", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "public-community-archive-user")
    const create = await requestJson("http://pirate.test/communities", {
      display_name: "Archive Preview Club",
      membership_mode: "request",
      handle_policy: { policy_template: "standard" },
    }, ctx.env, session.accessToken)
    expect(create.status).toBe(202)
    const communityId = ((await json(create)) as { community: { id: string } }).community.id

    // Visible while active.
    const activePreview = await app.request(`http://pirate.test/public-communities/${communityId}`, {}, ctx.env)
    expect(activePreview.status).toBe(200)

    // Archive flips control-plane status; preview must 404 (resolveCommunityRow rejects non-active).
    const archive = await requestJson(`http://pirate.test/communities/${communityId}/archive`, {}, ctx.env, session.accessToken)
    expect(archive.status).toBe(200)
    expect((await json(archive) as { status: string }).status).toBe("archived")

    const archivedPreview = await app.request(`http://pirate.test/public-communities/${communityId}`, {}, ctx.env)
    expect(archivedPreview.status).toBe(404)

    // Unarchive restores visibility.
    const unarchive = await requestJson(`http://pirate.test/communities/${communityId}/unarchive`, {}, ctx.env, session.accessToken)
    expect(unarchive.status).toBe(200)
    expect((await json(unarchive) as { status: string }).status).toBe("active")

    const restoredPreview = await app.request(`http://pirate.test/public-communities/${communityId}`, {}, ctx.env)
    expect(restoredPreview.status).toBe(200)
  })

  test("archived community blocks purchases (authenticated + public) and live-room create", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "archived-blocks-writes-user")
    const create = await requestJson("http://pirate.test/communities", {
      display_name: "Block Writes Club",
      membership_mode: "request",
      handle_policy: { policy_template: "standard" },
    }, ctx.env, session.accessToken)
    expect(create.status).toBe(202)
    const cid = ((await json(create)) as { community: { id: string } }).community.id

    const archive = await requestJson(`http://pirate.test/communities/${cid}/archive`, {}, ctx.env, session.accessToken)
    expect(archive.status).toBe(200)

    // Authenticated purchase quote — requireLiveCommunity fires before body parse.
    const authQuote = await requestJson(`http://pirate.test/communities/${cid}/purchase-quotes`, {}, ctx.env, session.accessToken)
    expect(authQuote.status).toBe(404)

    // Public purchase quote — resolveCommunityRow 404s before body parse.
    const pubQuote = await app.request(`http://pirate.test/public-communities/${cid}/purchase-quotes`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }, ctx.env)
    expect(pubQuote.status).toBe(404)

    // Public purchase settlement — same guard.
    const pubSettle = await app.request(`http://pirate.test/public-communities/${cid}/purchase-settlements`, {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }, ctx.env)
    expect(pubSettle.status).toBe(404)

    // Live-room create — existing requireLiveCommunity guard (regression pin).
    const liveRoom = await requestJson(`http://pirate.test/communities/${cid}/live-rooms`, {
      title: "blocked", description: "blocked",
    }, ctx.env, session.accessToken)
    expect(liveRoom.status).toBe(404)
  })

  test("archived community blocks membership + listing writes (isCommunityLive surfaces)", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const owner = await exchangeJwt(ctx.env, "archived-surfaces-owner")
    const create = await requestJson("http://pirate.test/communities", {
      display_name: "Surfaces Club",
      membership_mode: "request",
      handle_policy: { policy_template: "standard" },
    }, ctx.env, owner.accessToken)
    expect(create.status).toBe(202)
    const cid = ((await json(create)) as { community: { id: string } }).community.id

    expect((await requestJson(`http://pirate.test/communities/${cid}/archive`, {}, ctx.env, owner.accessToken)).status).toBe(200)

    // Membership join/request — isCommunityLive in request-service/eligibility.
    const joiner = await exchangeJwt(ctx.env, "archived-surfaces-joiner")
    const join = await requestJson(`http://pirate.test/communities/${cid}/join`, { note: "hi" }, ctx.env, joiner.accessToken)
    expect(join.status).toBe(404)

    // Follow — isCommunityLive in follow-service.
    const follow = await requestJson(`http://pirate.test/communities/${cid}/follow`, {}, ctx.env, joiner.accessToken)
    expect(follow.status).toBe(404)

    // Listing create — requireLiveCommunity guard from #64.
    const listing = await requestJson(`http://pirate.test/communities/${cid}/listings`, {
      title: "blocked", price_cents: 5,
    }, ctx.env, owner.accessToken)
    expect(listing.status).toBe(404)
  })
})
