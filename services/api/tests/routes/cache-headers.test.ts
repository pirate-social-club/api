import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  isPublicReadCacheRequest,
  NO_STORE_CACHE_HEADERS,
  PUBLIC_READ_CACHE_CONTROL,
  PUBLIC_READ_CDN_CACHE_CONTROL,
  setPublicReadCacheHeaders,
} from "../../src/routes/cache-headers"

async function publicReadCacheHeaderResponse(path: string): Promise<Response> {
  const app = new Hono()
  app.get("*", (c) => {
    setPublicReadCacheHeaders(c)
    return c.text("ok")
  })
  return app.request(`https://api.pirate.sc${path}`)
}

describe("public read cache headers", () => {
  test("identifies only cacheable public read GET requests", () => {
    expect(isPublicReadCacheRequest(new Request("https://api.pirate.sc/feed/home/public"))).toBe(true)
    expect(isPublicReadCacheRequest(new Request("https://api.pirate.sc/feed/home"))).toBe(true)
    expect(isPublicReadCacheRequest(new Request("https://api.pirate.sc/feed/home", {
      headers: { Authorization: "Bearer token" },
    }))).toBe(false)
    expect(isPublicReadCacheRequest(new Request("https://api.pirate.sc/public-posts/pst_1"))).toBe(true)
    expect(isPublicReadCacheRequest(new Request("https://api.pirate.sc/public-comments/pst_1"))).toBe(true)
    expect(isPublicReadCacheRequest(new Request("https://api.pirate.sc/public-communities/community-slug"))).toBe(true)
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
})

describe("operational endpoint no-store headers", () => {
  test("marks every cache tier no-store so the CDN never serves a stale version/health body", () => {
    expect(NO_STORE_CACHE_HEADERS["cache-control"]).toBe("no-store")
    expect(NO_STORE_CACHE_HEADERS["cdn-cache-control"]).toBe("no-store")
    expect(NO_STORE_CACHE_HEADERS["cloudflare-cdn-cache-control"]).toBe("no-store")
  })

  test("applying the headers to a JSON response sets all three cache tiers", async () => {
    const app = new Hono()
    app.get("/__version", (c) => c.json({ service: "api" }, 200, { ...NO_STORE_CACHE_HEADERS }))
    const response = await app.request("https://api.pirate.sc/__version")

    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("cdn-cache-control")).toBe("no-store")
    expect(response.headers.get("cloudflare-cdn-cache-control")).toBe("no-store")
  })
})
