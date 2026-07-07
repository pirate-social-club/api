import { describe, expect, test } from "bun:test"
import { Hono } from "hono"

import {
  isPublicReadCacheRequest,
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
