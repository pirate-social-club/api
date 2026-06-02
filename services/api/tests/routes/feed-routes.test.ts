import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import handler, { app } from "../../src/index"
import {
  buildMaterializedPublicHomeFeedTarget,
  parseMaterializedPublicHomeFeedBody,
} from "../../src/lib/feed/materialized-public-feed"
import { createRouteTestContext, json, resetRuntimeCaches } from "../helpers"
import {
  completeUniqueHumanVerification,
  exchangeJwt,
  requestJson,
} from "./communities/community-routes-test-helpers"

let cleanup: (() => Promise<void>) | null = null
const originalCachesDescriptor = Object.getOwnPropertyDescriptor(globalThis, "caches")

beforeEach(() => {
  resetRuntimeCaches()
})

afterEach(async () => {
  if (originalCachesDescriptor) {
    Object.defineProperty(globalThis, "caches", originalCachesDescriptor)
  } else {
    Reflect.deleteProperty(globalThis, "caches")
  }
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

function setTestCaches(cache: {
  match: (request: Request) => Promise<Response | undefined>
  put: (request: Request, response: Response) => Promise<void>
}) {
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      open: async () => cache,
    },
  })
}

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
          primary_database_binding_id,
          created_at,
          updated_at
        ) VALUES
          (?1, ?2, ?3, 'request', 'active', 'active', 'none', ?4, NULL, NULL, NULL, ?5, ?5),
          (?6, ?2, ?7, 'request', 'draft', 'requested', 'none', ?8, NULL, NULL, NULL, ?9, ?9)
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
    expect(response.headers.get("cdn-cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=300")
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=60, stale-while-revalidate=300")
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
          community: {
            viewer_community_role: string | null
            viewer_membership_status: string | null
            membership_gate_summaries: unknown[]
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
    expect(body.items[0]?.post.community?.viewer_community_role).toBe("owner")
    expect(body.items[0]?.post.community?.viewer_membership_status).toBe("member")
    expect(Array.isArray(body.items[0]?.post.community?.membership_gate_summaries)).toBe(true)
    expect(body.top_communities.map((community) => community.display_name)).toContain("Feed Reader Club")
    expect(body.next_cursor).toBeNull()
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
    expect(response.headers.get("cdn-cache-control")).toBe("public, s-maxage=60, stale-while-revalidate=300")
    expect(response.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=60, stale-while-revalidate=300")
    expect(response.headers.get("server-timing")).toContain("home-feed;dur=")
    expect(response.headers.get("server-timing")).toContain("viewer;dur=")
    expect(response.headers.get("vary")).not.toContain("Authorization")
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
    expect(response.headers.get("vary")).not.toContain("Authorization")
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

  test("public read cache wrapper annotates feed misses and hits", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    let cachedResponse: Response | undefined
    let storedResponse: Response | undefined
    let putCount = 0
    setTestCaches({
      match: async () => cachedResponse?.clone(),
      put: async (_request, response) => {
        putCount += 1
        storedResponse = response
        cachedResponse = response.clone()
      },
    })

    const missExecution = createExecutionContext()
    const miss = await fetchHandler(
      new Request("http://pirate.test/feed/home/public?sort=best&locale=en"),
      ctx.env,
      missExecution.ctx,
    )
    expect(miss.headers.get("x-pirate-cache")).toBe("miss")
    expect(miss.headers.get("x-pirate-cache-stored")).toBe("1")
    expect(storedResponse?.headers.get("x-pirate-cache")).toBeNull()
    expect(storedResponse?.headers.get("cache-control")).toBe("public, max-age=360")
    expect(storedResponse?.headers.get("cdn-cache-control")).toBe("public, max-age=360")
    expect(storedResponse?.headers.get("x-pirate-cache-created-at")).not.toBeNull()
    await Promise.all(missExecution.waitUntilPromises)
    expect(putCount).toBe(1)

    const hitExecution = createExecutionContext()
    const hit = await fetchHandler(
      new Request("http://pirate.test/feed/home/public?sort=best&locale=en"),
      ctx.env,
      hitExecution.ctx,
    )
    expect(hit.headers.get("x-pirate-cache")).toBe("hit")
    expect(hit.headers.get("x-pirate-cache-stored")).toBeNull()
    expect(hit.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=60, stale-while-revalidate=300")
    expect(hit.headers.get("x-pirate-cache-created-at")).toBeNull()

    cachedResponse = new Response(JSON.stringify({
      items: [],
      next_cursor: null,
      top_communities: [],
    }), {
      headers: {
        "cache-control": "public, max-age=360",
        "cdn-cache-control": "public, s-maxage=60, stale-while-revalidate=300",
        "content-type": "application/json",
        "x-pirate-cache-created-at": String(Date.now() - 61_000),
      },
      status: 200,
    })
    const staleExecution = createExecutionContext()
    const stale = await fetchHandler(
      new Request("http://pirate.test/feed/home/public?sort=best&locale=en"),
      ctx.env,
      staleExecution.ctx,
    )
    expect(stale.headers.get("x-pirate-cache")).toBe("stale")
    expect(stale.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=60, stale-while-revalidate=300")
    expect(stale.headers.get("x-pirate-cache-created-at")).toBeNull()
    expect(staleExecution.waitUntilPromises.length).toBeGreaterThanOrEqual(1)
    await Promise.all(staleExecution.waitUntilPromises)
    expect(cachedResponse.headers.get("x-pirate-cache-created-at")).not.toBeNull()
  })

  test("public read cache wrapper dedupes concurrent misses and stale refreshes", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    let cachedResponse: Response | undefined
    let putCount = 0
    setTestCaches({
      match: async () => cachedResponse?.clone(),
      put: async (_request, response) => {
        putCount += 1
        cachedResponse = response.clone()
      },
    })

    const firstMissExecution = createExecutionContext()
    const secondMissExecution = createExecutionContext()
    const [firstMiss, secondMiss] = await Promise.all([
      fetchHandler(
        new Request("http://pirate.test/feed/home/public?sort=best&locale=en&dedupe=miss"),
        ctx.env,
        firstMissExecution.ctx,
      ),
      fetchHandler(
        new Request("http://pirate.test/feed/home/public?sort=best&locale=en&dedupe=miss"),
        ctx.env,
        secondMissExecution.ctx,
      ),
    ])
    expect([firstMiss.headers.get("x-pirate-cache"), secondMiss.headers.get("x-pirate-cache")]).toEqual(["miss", "miss"])
    expect([firstMiss.headers.get("x-pirate-cache-deduped"), secondMiss.headers.get("x-pirate-cache-deduped")].filter(Boolean)).toEqual(["1"])
    await Promise.all([
      ...firstMissExecution.waitUntilPromises,
      ...secondMissExecution.waitUntilPromises,
    ])
    expect(putCount).toBe(1)

    cachedResponse = new Response(JSON.stringify({
      items: [],
      next_cursor: null,
      top_communities: [],
    }), {
      headers: {
        "cache-control": "public, max-age=360",
        "cdn-cache-control": "public, max-age=360",
        "content-type": "application/json",
        "x-pirate-cache-created-at": String(Date.now() - 61_000),
      },
      status: 200,
    })
    putCount = 0
    const firstStaleExecution = createExecutionContext()
    const secondStaleExecution = createExecutionContext()
    const [firstStale, secondStale] = await Promise.all([
      fetchHandler(
        new Request("http://pirate.test/feed/home/public?sort=best&locale=en&dedupe=stale"),
        ctx.env,
        firstStaleExecution.ctx,
      ),
      fetchHandler(
        new Request("http://pirate.test/feed/home/public?sort=best&locale=en&dedupe=stale"),
        ctx.env,
        secondStaleExecution.ctx,
      ),
    ])
    expect([firstStale.headers.get("x-pirate-cache"), secondStale.headers.get("x-pirate-cache")]).toEqual(["stale", "stale"])
    await Promise.all([
      ...firstStaleExecution.waitUntilPromises,
      ...secondStaleExecution.waitUntilPromises,
    ])
    expect(putCount).toBe(1)
  })
})
