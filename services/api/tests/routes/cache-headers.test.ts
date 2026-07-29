import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import { app } from "../../src/index"
import {
  isPublicReadCacheRequest,
  PUBLIC_READ_CACHE_CONTROL,
  PUBLIC_READ_CDN_CACHE_CONTROL,
  setPublicReadCacheHeaders,
} from "../../src/routes/cache-headers"
import { buildTestEnv } from "../helpers"

async function publicReadCacheHeaderResponse(
  path: string,
  options?: Parameters<typeof setPublicReadCacheHeaders>[1],
): Promise<Response> {
  const app = new Hono()
  app.get("*", (c) => {
    setPublicReadCacheHeaders(c, options)
    return c.text("ok")
  })
  return app.request(`https://api.pirate.sc${path}`)
}

describe("public read cache headers", () => {
  test("identifies only cacheable public read GET requests", () => {
    expect(isPublicReadCacheRequest(new Request("https://api.pirate.sc/feed/home/public"))).toBe(true)
    expect(isPublicReadCacheRequest(new Request("https://api.pirate.sc/feed/home/videos/public"))).toBe(true)
    expect(isPublicReadCacheRequest(new Request("https://api.pirate.sc/feed/home"))).toBe(true)
    expect(isPublicReadCacheRequest(new Request("https://api.pirate.sc/feed/home", {
      headers: { Authorization: "Bearer token" },
    }))).toBe(false)
    expect(isPublicReadCacheRequest(new Request("https://api.pirate.sc/feed/home/public", {
      headers: { Authorization: "Bearer ignored-by-public-route" },
    }))).toBe(true)
    expect(isPublicReadCacheRequest(new Request("https://api.pirate.sc/public-posts/pst_1"))).toBe(true)
    expect(isPublicReadCacheRequest(new Request("https://api.pirate.sc/public-comments/pst_1"))).toBe(true)
    expect(isPublicReadCacheRequest(new Request("https://api.pirate.sc/public-communities/community-slug"))).toBe(true)
    expect(isPublicReadCacheRequest(new Request("https://api.pirate.sc/public/reward_campaigns?community_id=c1&post_id=p1"))).toBe(true)
    expect(isPublicReadCacheRequest(new Request("https://api.pirate.sc/public/reward_campaigns/rcp_1"))).toBe(true)
    expect(isPublicReadCacheRequest(new Request("https://api.pirate.sc/posts/pst_1"))).toBe(false)
    expect(isPublicReadCacheRequest(new Request("https://api.pirate.sc/feed/home/public", {
      method: "POST",
    }))).toBe(false)
  })

  test("emits cache headers without Vary for public feed responses", async () => {
    const response = await publicReadCacheHeaderResponse("/feed/home/public?sort=best&locale=en")

    expect(response.headers.get("cache-control")).toBe(PUBLIC_READ_CACHE_CONTROL)
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe(PUBLIC_READ_CDN_CACHE_CONTROL)
    expect(response.headers.get("cdn-cache-control")).toBe(PUBLIC_READ_CDN_CACHE_CONTROL)
    expect(response.headers.get("cdn-cache-control")).not.toContain("s-maxage")
    expect(response.headers.get("vary")).toBeNull()
  })

  test("emits Vary: Accept for structured public read responses", async () => {
    const response = await publicReadCacheHeaderResponse("/public-posts/pst_1")

    expect(response.headers.get("cache-control")).toBe(PUBLIC_READ_CACHE_CONTROL)
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe(PUBLIC_READ_CDN_CACHE_CONTROL)
    expect(response.headers.get("cdn-cache-control")).toBe(PUBLIC_READ_CDN_CACHE_CONTROL)
    expect(response.headers.get("cdn-cache-control")).not.toContain("s-maxage")
    expect(response.headers.get("vary")).toBe("Accept")
  })

  test("emits normalized cache tags when provided", async () => {
    const response = await publicReadCacheHeaderResponse("/public-posts/post_pst_1", {
      cacheTags: ["post:post_pst_1", "community:com_cmt_1", "post:post_pst_1", "bad tag/value"],
    })

    expect(response.headers.get("cache-tag")).toBe("post:post_pst_1,community:com_cmt_1,bad_tag_value")
  })

  test("supports a short CDN lifetime for time-sensitive public offers", async () => {
    const response = await publicReadCacheHeaderResponse("/public/reward_campaigns", {
      freshSeconds: 15,
      staleSeconds: 15,
    })

    expect(response.headers.get("cache-control")).toBe(PUBLIC_READ_CACHE_CONTROL)
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("public, max-age=15, stale-while-revalidate=15")
  })
})

describe("credential-bearing response cache headers", () => {
  test.each([
    "authorization",
    "x-admin-token",
    "x-agent-connection-token",
    "x-very-callback-secret",
    "x-karaoke-finalize-secret",
    "x-telegram-bot-secret",
    "x-telegram-bot-api-secret-token",
  ])("makes successful requests with %s private and non-cacheable", async (header) => {
    const response = await app.request("https://api.pirate.test/health", {
      headers: { [header]: "test-credential" },
    }, buildTestEnv())

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toContain("private")
    expect(response.headers.get("cache-control")).toContain("no-store")
    expect(response.headers.get("pragma")).toBe("no-cache")
  })

  test("overrides explicit public cache headers on a credential-bearing request", async () => {
    const response = await app.request(
      "https://api.pirate.test/.well-known/agent-tools/guest-comment.mjs",
      { headers: { authorization: "Bearer test-credential" } },
      buildTestEnv(),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toContain("private")
    expect(response.headers.get("cache-control")).toContain("no-store")
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBeNull()
    expect(response.headers.get("cdn-cache-control")).toBeNull()
    expect(response.headers.get("cache-tag")).toBeNull()
  })

  test("makes thrown authentication errors private and non-cacheable", async () => {
    const response = await app.request("https://api.pirate.test/posts/pst_missing", {
      headers: { authorization: "Bearer invalid-token" },
    }, buildTestEnv())

    expect(response.status).toBe(401)
    expect(response.headers.get("cache-control")).toContain("private")
    expect(response.headers.get("cache-control")).toContain("no-store")
    expect(response.headers.get("pragma")).toBe("no-cache")
  })

  test("does not alter anonymous public cache policy", async () => {
    const response = await app.request(
      "https://api.pirate.test/.well-known/agent-tools/guest-comment.mjs",
      {},
      buildTestEnv(),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("public, max-age=60, s-maxage=60")
  })
})
