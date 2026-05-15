import { describe, expect, test } from "bun:test"

import { buildPublicReadCacheKey } from "../../src/routes/cache-headers"

function cacheKeyUrl(url: string, headers?: HeadersInit): string {
  return buildPublicReadCacheKey(new Request(url, { headers })).url
}

describe("public read cache keys", () => {
  test("canonicalizes equivalent query parameter ordering", () => {
    const headers = { Origin: "https://pirate.sc" }
    const first = cacheKeyUrl("https://api.pirate.sc/feed/home/public?sort=best&locale=en", headers)
    const second = cacheKeyUrl("https://api.pirate.sc/feed/home/public?locale=en&sort=best", headers)

    expect(second).toBe(first)
    expect(first).toContain("locale=en")
    expect(first).toContain("sort=best")
  })

  test("still varies feed cache keys by origin", () => {
    const production = cacheKeyUrl("https://api.pirate.sc/feed/home/public?locale=en&sort=best", {
      Origin: "https://pirate.sc",
    })
    const staging = cacheKeyUrl("https://api.pirate.sc/feed/home/public?locale=en&sort=best", {
      Origin: "https://staging.pirate.sc",
    })

    expect(staging).not.toBe(production)
    expect(production).toContain("__cache_origin=https%3A%2F%2Fpirate.sc")
    expect(staging).toContain("__cache_origin=https%3A%2F%2Fstaging.pirate.sc")
  })
})
