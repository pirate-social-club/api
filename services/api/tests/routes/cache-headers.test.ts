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

  test("does not vary public feed cache keys by origin", () => {
    const production = cacheKeyUrl("https://api.pirate.sc/feed/home/public?locale=en&sort=best", {
      Origin: "https://pirate.sc",
    })
    const staging = cacheKeyUrl("https://api.pirate.sc/feed/home/public?locale=en&sort=best", {
      Origin: "https://staging.pirate.sc",
    })

    expect(staging).toBe(production)
    expect(production).not.toContain("__cache_origin=")
  })

  test("varies structured public read cache keys by representation headers, not origin or language", () => {
    const json = cacheKeyUrl("https://api.pirate.sc/public-posts/pst_1", {
      Accept: "application/json",
      "Accept-Language": "en-US",
      Origin: "https://pirate.sc",
    })
    const markdown = cacheKeyUrl("https://api.pirate.sc/public-posts/pst_1", {
      Accept: "text/markdown",
      "Accept-Language": "en-US",
      Origin: "https://pirate.sc",
    })
    const stagingJson = cacheKeyUrl("https://api.pirate.sc/public-posts/pst_1", {
      Accept: "application/json",
      "Accept-Language": "fr-FR",
      Origin: "https://staging.pirate.sc",
    })

    expect(markdown).not.toBe(json)
    expect(stagingJson).toBe(json)
    expect(json).toContain("__cache_accept=application%2Fjson")
    expect(json).not.toContain("__cache_accept-language=")
    expect(json).not.toContain("__cache_origin=")
  })
})
