import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import handler, { app } from "../../src/index"
import {
  buildMaterializedPublicHomeFeedTarget,
  parseMaterializedPublicHomeFeedBody,
} from "../../src/lib/feed/materialized-public-feed"
import {
  PUBLIC_READ_CACHE_CONTROL,
  PUBLIC_READ_CDN_CACHE_CONTROL,
} from "../../src/routes/cache-headers"
import { createRouteTestContext, json, resetRuntimeCaches } from "../helpers"
import {
  completeUniqueHumanVerification,
  exchangeJwt,
  requestJson,
  updateLocalCommunityAnonymousPolicy,
} from "./communities/community-routes-test-helpers"

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

function createExecutionContext() {
  const waitUntilPromises: Promise<unknown>[] = []
  return {
    ctx: {
      waitUntil: (promise: Promise<unknown>) => {
        waitUntilPromises.push(promise)
      },
    } as ExecutionContext,
    waitUntilPromises,
  }
}

function fetchHandler(request: Request, env: Parameters<NonNullable<typeof handler.fetch>>[1], ctx: ExecutionContext): Promise<Response> {
  if (!handler.fetch) {
    throw new Error("handler fetch is not configured")
  }
  return Promise.resolve(handler.fetch(request as Parameters<NonNullable<typeof handler.fetch>>[0], env, ctx))
}

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
          created_at,
          updated_at
        ) VALUES
          (?1, ?2, ?3, 'request', 'active', 'active', 'none', ?4, NULL, NULL, ?5, ?5),
          (?6, ?2, ?7, 'request', 'draft', 'requested', 'none', ?8, NULL, NULL, ?9, ?9)
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
    expect(response.headers.get("cdn-cache-control")).toBe(PUBLIC_READ_CDN_CACHE_CONTROL)
    expect(response.headers.get("cache-control")).toBe(PUBLIC_READ_CACHE_CONTROL)
    expect(response.headers.get("server-timing")).toContain("home-feed;dur=")
    expect(response.headers.get("server-timing")).toContain("viewer;dur=")
    expect(response.headers.get("vary")).toContain("Authorization")
    const body = await json(response) as {
      items: unknown[]
      top_communities: Array<{
        id: string
        object: string
        display_name: string
        route_slug: string | null
        view_count: number | null
      }>
      next_cursor: string | null
    }

    expect(body.items).toEqual([])
    expect(body.next_cursor).toBeNull()
    expect(Object.keys(body)).toEqual(["items", "top_communities", "next_cursor"])
    expect(body.top_communities).toHaveLength(1)
    expect(body.top_communities[0]).toMatchObject({
      id: "com_cmt_feed_active",
      object: "home_feed_community_summary",
      display_name: "Feed Active",
      route_slug: "feed-active",
      view_count: 0,
    })
  })

  test("GET /feed/home reads projected posts from community databases", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "feed-route-post-reader")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Feed Reader Club",
      membership_mode: "request",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityCreateBody = await json(communityCreate) as {
      community: {
        id: string
        display_name: string
      }
    }
    const communityId = communityCreateBody.community.id.replace(/^com_/, "")

    const createdPost = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        post_type: "text",
        title: "Home feed projection",
        body: "This post should be read through the home feed fanout path.",
        idempotency_key: "feed-route-post-reader-post",
      },
      ctx.env,
      session.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const createdPostBody = await json(createdPost) as {
      id: string
    }

    const response = await app.request("http://pirate.test/feed/home?sort=new&time_range=all", {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
      },
    }, ctx.env)
    expect(response.status).toBe(200)
    const body = await json(response) as {
      items: Array<{
        community: {
          display_name: string
        }
        post: {
          community: null
          viewer_gate_state: {
            community_id: string
            community_display_name: string
            viewer_community_role: string | null
            viewer_membership_status: string | null
            membership_gate_summaries: unknown[]
            gate_match_mode: "all" | "any" | null
          } | null
          post: {
            id: string
            title: string | null
          }
        }
      }>
      top_communities: Array<{
        display_name: string
      }>
      next_cursor: string | null
    }

    expect(body.items).toHaveLength(1)
    expect(body.items[0]?.community.display_name).toBe("Feed Reader Club")
    expect(body.items[0]?.post.post.id).toBe(createdPostBody.id)
    expect(body.items[0]?.post.post.title).toBe("Home feed projection")
    expect(body.items[0]?.post.community).toBeNull()
    expect(body.items[0]?.post.viewer_gate_state?.community_id).toBe(`com_${communityId}`)
    expect(body.items[0]?.post.viewer_gate_state?.community_display_name).toBe("Feed Reader Club")
    expect(body.items[0]?.post.viewer_gate_state?.viewer_community_role).toBe("owner")
    expect(body.items[0]?.post.viewer_gate_state?.viewer_membership_status).toBe("member")
    expect(Array.isArray(body.items[0]?.post.viewer_gate_state?.membership_gate_summaries)).toBe(true)
    expect(body.top_communities.map((community) => community.display_name)).toContain("Feed Reader Club")
    expect(body.next_cursor).toBeNull()
  })

  test("GET /feed/home stamps the public author handle so feed bylines match the community read", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "feed-route-handle-reader")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const communityCreate = await requestJson("http://pirate.test/communities", {
      display_name: "Feed Handle Club",
      membership_mode: "request",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(communityCreate.status).toBe(202)
    const communityId = ((await json(communityCreate)) as {
      community: { id: string }
    }).community.id.replace(/^com_/, "")

    const createdPost = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        post_type: "text",
        title: "Byline parity post",
        body: "The feed byline should match the community read byline on first paint.",
        idempotency_key: "feed-route-handle-post",
      },
      ctx.env,
      session.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postId = ((await json(createdPost)) as { id: string }).id

    // An anonymous post by the same author must never leak the public handle into
    // the feed byline, even though hydration now runs on the feed path.
    await updateLocalCommunityAnonymousPolicy({
      allowAnonymousIdentity: true,
      anonymousIdentityScope: "community_stable",
      communityDbRoot: ctx.communityDbRoot,
      communityId,
    })
    const anonymousPost = await requestJson(
      `http://pirate.test/communities/${communityId}/posts`,
      {
        post_type: "text",
        identity_mode: "anonymous",
        anonymous_scope: "community_stable",
        title: "Anonymous byline post",
        body: "Anonymous feed cards must keep author_public_handle null.",
        idempotency_key: "feed-route-handle-anon-post",
      },
      ctx.env,
      session.accessToken,
    )
    expect(anonymousPost.status).toBe(201)
    const anonymousPostId = ((await json(anonymousPost)) as { id: string }).id

    // The single-community read path already hydrates the public author handle,
    // so it is the source of truth for the byline the feed must match.
    const communityList = await app.request(
      `http://pirate.test/communities/${communityId}/posts?sort=new`,
      { headers: { authorization: `Bearer ${session.accessToken}` } },
      ctx.env,
    )
    expect(communityList.status).toBe(200)
    const communityCard = ((await json(communityList)) as {
      items: Array<{ post: { id: string; author_public_handle: string | null } }>
    }).items.find((item) => item.post.id === postId)
    const expectedHandle = communityCard?.post.author_public_handle
    // Guard against a vacuous assertion: the author must actually resolve to a
    // public handle, otherwise `null === null` would pass with or without the fix.
    expect(typeof expectedHandle).toBe("string")
    expect(expectedHandle).toBeTruthy()

    // The home-feed fanout builds and serializes its own responses; before the
    // handle hydrator was wired in it emitted `author_public_handle: null`, so
    // feed cards flashed the truncated id before a client profile fetch swapped
    // in the handle. It must now match the community read on first paint.
    const feed = await app.request("http://pirate.test/feed/home?sort=new&time_range=all", {
      headers: { authorization: `Bearer ${session.accessToken}` },
    }, ctx.env)
    expect(feed.status).toBe(200)
    const feedItems = ((await json(feed)) as {
      items: Array<{ post: { post: { id: string; identity_mode: string; author_public_handle: string | null } } }>
    }).items
    const feedCard = feedItems.find((item) => item.post.post.id === postId)
    expect(feedCard?.post.post.author_public_handle).toBe(expectedHandle ?? null)

    const anonymousCard = feedItems.find((item) => item.post.post.id === anonymousPostId)
    expect(anonymousCard?.post.post.identity_mode).toBe("anonymous")
    expect(anonymousCard?.post.post.author_public_handle).toBeNull()
  })

  test("GET /feed/home hydrates crosspost source previews", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "feed-route-crosspost-reader")
    await completeUniqueHumanVerification(ctx.env, session.accessToken)

    const sourceCommunity = await requestJson("http://pirate.test/communities", {
      display_name: "Feed Source Club",
      membership_mode: "request",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(sourceCommunity.status).toBe(202)
    const sourceCommunityBody = await json(sourceCommunity) as {
      community: {
        id: string
      }
    }
    const sourceCommunityId = sourceCommunityBody.community.id.replace(/^com_/, "")

    const targetCommunity = await requestJson("http://pirate.test/communities", {
      display_name: "Feed Target Club",
      membership_mode: "request",
      handle_policy: {
        policy_template: "standard",
      },
    }, ctx.env, session.accessToken)
    expect(targetCommunity.status).toBe(202)
    const targetCommunityBody = await json(targetCommunity) as {
      community: {
        id: string
      }
    }
    const targetCommunityId = targetCommunityBody.community.id.replace(/^com_/, "")

    const sourcePost = await requestJson(
      `http://pirate.test/communities/${sourceCommunityId}/posts`,
      {
        post_type: "text",
        title: "Original feed source",
        body: "This source should hydrate inside a crosspost preview.",
        idempotency_key: "feed-route-crosspost-source",
      },
      ctx.env,
      session.accessToken,
    )
    expect(sourcePost.status).toBe(201)
    const sourcePostBody = await json(sourcePost) as {
      id: string
    }

    const crosspost = await requestJson(
      `http://pirate.test/communities/${targetCommunityId}/posts`,
      {
        post_type: "crosspost",
        title: "Sharing this into the target feed",
        source_post: sourcePostBody.id,
        source_community: sourceCommunityBody.community.id,
        idempotency_key: "feed-route-crosspost-target",
      },
      ctx.env,
      session.accessToken,
    )
    expect(crosspost.status).toBe(201)
    const crosspostBody = await json(crosspost) as {
      id: string
    }

    const response = await app.request("http://pirate.test/feed/home?sort=new&time_range=all", {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
      },
    }, ctx.env)
    expect(response.status).toBe(200)
    const body = await json(response) as {
      items: Array<{
        post: {
          post: {
            id: string
            post_type: string
            crosspost_source?: {
              status: string
              post: string
              community: string
              post_type: string | null
              title: string | null
              community_label: string | null
              author_user: string | null
            } | null
          }
        }
      }>
    }

    const crosspostItem = body.items.find((item) => item.post.post.id === crosspostBody.id)
    expect(crosspostItem?.post.post.post_type).toBe("crosspost")
    expect(crosspostItem?.post.post.crosspost_source).toMatchObject({
      status: "available",
      post: sourcePostBody.id,
      community: sourceCommunityBody.community.id,
      post_type: "text",
      title: "Original feed source",
      community_label: "Feed Source Club",
    })
    expect(crosspostItem?.post.post.crosspost_source?.author_user).toBe(`usr_${session.userId}`)

    const deleteSource = await requestJson(
      `http://pirate.test/communities/${sourceCommunityId}/posts/${sourcePostBody.id}/delete`,
      {},
      ctx.env,
      session.accessToken,
    )
    expect(deleteSource.status).toBe(200)

    const afterDeleteResponse = await app.request("http://pirate.test/feed/home?sort=new&time_range=all", {
      headers: {
        authorization: `Bearer ${session.accessToken}`,
      },
    }, ctx.env)
    expect(afterDeleteResponse.status).toBe(200)
    const afterDeleteBody = await json(afterDeleteResponse) as typeof body
    const crosspostAfterDelete = afterDeleteBody.items.find((item) => item.post.post.id === crosspostBody.id)
    expect(crosspostAfterDelete?.post.post.crosspost_source).toMatchObject({
      status: "deleted",
      post: sourcePostBody.id,
      community: sourceCommunityBody.community.id,
      post_type: null,
      title: null,
      community_label: null,
      author_user: null,
    })
  })

  test("GET /feed/home/public returns the public feed without auth variance", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const response = await app.request("http://pirate.test/feed/home/public?sort=best&locale=en", {
      headers: {
        Authorization: "Bearer ignored-public-token",
      },
    }, ctx.env)
    expect(response.status).toBe(200)
    expect(response.headers.get("cdn-cache-control")).toBe(PUBLIC_READ_CDN_CACHE_CONTROL)
    expect(response.headers.get("cache-control")).toBe(PUBLIC_READ_CACHE_CONTROL)
    expect(response.headers.get("server-timing")).toContain("home-feed;dur=")
    expect(response.headers.get("server-timing")).toContain("viewer;dur=")
    expect(response.headers.get("vary") ?? "").not.toContain("Authorization")
    const body = await json(response) as {
      items: unknown[]
      top_communities: unknown[]
      next_cursor: string | null
    }

    expect(body.items).toEqual([])
    expect(body.top_communities).toEqual([])
    expect(body.next_cursor).toBeNull()
    expect(Object.keys(body)).toEqual(["items", "top_communities", "next_cursor"])
  })

  test("GET /feed/home/public skips projected communities with missing routing", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "feed-route-missing-routing")
    const now = "2026-05-12T10:04:00.000Z"

    await ctx.client.batch([
      {
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
          ) VALUES (
            'cmt_missing_feed_route',
            ?2,
            'Missing Feed Route',
            'request',
            'active',
            'active',
            'none',
            'missing-feed-route',
            NULL,
            NULL,
            ?1,
            ?1
          )
        `,
        args: [now, session.userId],
      },
      {
        sql: `
          INSERT INTO community_post_projections (
            projection_id, community_id, source_post_id, author_user_id, identity_mode,
            post_type, status, visibility, upvote_count, downvote_count, comment_count,
            like_count, source_created_at, projected_payload_json, projection_version,
            created_at, updated_at
          ) VALUES (
            'cpp_missing_feed_route',
            'cmt_missing_feed_route',
            'pst_missing_feed_route',
            'usr_missing_feed_route',
            'public',
            'text',
            'published',
            'public',
            0,
            0,
            0,
            0,
            ?1,
            '{}',
            1,
            ?1,
            ?1
          )
        `,
        args: [now],
      },
    ])

    const response = await app.request("http://pirate.test/feed/home/public?sort=best&locale=en&dedupe=miss", {}, ctx.env)
    expect(response.status).toBe(200)
    const body = await json(response) as {
      items: unknown[]
      next_cursor: string | null
    }

    expect(body.items).toEqual([])
    expect(body.next_cursor).toBeNull()
  })

  test("GET /feed/home/public serves a fresh materialized default public feed", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const target = buildMaterializedPublicHomeFeedTarget({
      locale: "en",
      sort: "best",
      timeRange: "all",
      cursor: null,
    })
    if (!target) {
      throw new Error("expected materialized target")
    }
    const now = Date.now()
    const materializedBody = {
      items: [],
      top_communities: [{
        id: "com_cached_home",
        object: "home_feed_community_summary",
        display_name: "Cached Home",
        route_slug: "cached-home",
        avatar_url: null,
        view_count: 12,
      }],
      next_cursor: null,
    }

    await ctx.client.execute({
      sql: `
        INSERT INTO materialized_public_feeds (
          cache_key,
          json_body,
          created_at,
          refreshed_at,
          expires_at,
          stale_at,
          source_version
        ) VALUES (?1, ?2, ?3, ?3, ?4, ?5, ?6)
      `,
      args: [
        target.cacheKey,
        JSON.stringify(materializedBody),
        new Date(now).toISOString(),
        new Date(now + 60_000).toISOString(),
        new Date(now + 600_000).toISOString(),
        "test-materialized",
      ],
    })

    const response = await app.request("http://pirate.test/feed/home/public?sort=best&locale=en", {}, ctx.env)
    expect(response.status).toBe(200)
    expect(response.headers.get("x-pirate-materialized-feed")).toBe("hit")
    expect(response.headers.get("server-timing")).toContain("materialized-public-feed-hit;dur=")
    expect(response.headers.get("vary") ?? "").not.toContain("Authorization")
    expect(await json(response)).toEqual(materializedBody)
  })

  test("GET /feed/home/public stores the default public feed after a materialized miss", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const target = buildMaterializedPublicHomeFeedTarget({
      locale: "en",
      sort: "best",
      timeRange: "all",
      cursor: null,
    })
    if (!target) {
      throw new Error("expected materialized target")
    }

    const response = await app.request("http://pirate.test/feed/home/public?sort=best&locale=en", {}, ctx.env)
    expect(response.status).toBe(200)
    expect(response.headers.get("x-pirate-materialized-feed")).toBe("miss")
    const stored = await ctx.client.execute({
      sql: `
        SELECT json_body, expires_at, stale_at
        FROM materialized_public_feeds
        WHERE cache_key = ?1
        LIMIT 1
      `,
      args: [target.cacheKey],
    })

    expect(stored.rows).toHaveLength(1)
    expect(typeof stored.rows[0]?.json_body).toBe("string")
    expect(Date.parse(String(stored.rows[0]?.expires_at))).toBeGreaterThan(Date.now())
    expect(Date.parse(String(stored.rows[0]?.stale_at))).toBeGreaterThan(Date.parse(String(stored.rows[0]?.expires_at)))
  })

  test("materialized feed parser accepts Postgres JSONB objects", () => {
    const body = {
      items: [],
      top_communities: [],
      next_cursor: null,
    }

    expect(parseMaterializedPublicHomeFeedBody(body)).toEqual(body)
    expect(parseMaterializedPublicHomeFeedBody(JSON.stringify(body))).toEqual(body)
  })

  test("public read gateway normalizes before the inner entrypoint and applies CORS after", async () => {
    const forwardedRequests: Request[] = []

    const execution = createExecutionContext()
    const ctxWithExports = Object.assign(execution.ctx, {
      exports: {
        CachedPublicReads: {
          fetch: async (request: Request) => {
            forwardedRequests.push(request.clone() as Request)
            return new Response(JSON.stringify({
              items: [],
              next_cursor: null,
              top_communities: [],
            }), {
              headers: {
                "cache-control": PUBLIC_READ_CACHE_CONTROL,
                "cdn-cache-control": PUBLIC_READ_CDN_CACHE_CONTROL,
                "content-type": "application/json",
              },
            })
          },
        },
      },
    }) as ExecutionContext

    const response = await fetchHandler(
      new Request("http://pirate.test/feed/home/public?sort=best&locale=en", {
        headers: {
          Authorization: "Bearer should-not-cross",
          Origin: "https://app.pirate.test",
        },
      }),
      {
        CORS_ALLOWED_ORIGINS: "https://app.pirate.test",
      } as Parameters<NonNullable<typeof handler.fetch>>[1],
      ctxWithExports,
    )

    expect(response.headers.get("access-control-allow-origin")).toBe("https://app.pirate.test")
    expect(response.headers.get("vary")).toBe("Origin")
    expect(response.headers.get("x-pirate-cache")).toBeNull()
    expect(forwardedRequests).toHaveLength(1)
    expect(forwardedRequests[0]?.headers.get("authorization")).toBeNull()
    expect(forwardedRequests[0]?.headers.get("origin")).toBeNull()
  })
})
