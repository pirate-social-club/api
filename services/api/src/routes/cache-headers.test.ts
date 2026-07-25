import { describe, expect, test } from "bun:test"

import { isPublicReadCacheRequest } from "./cache-headers"

describe("isPublicReadCacheRequest", () => {
  test("caches both public homepage feed variants", () => {
    expect(isPublicReadCacheRequest(
      new Request("https://api.pirate.test/feed/home/public?locale=en&sort=best"),
    )).toBe(true)
    expect(isPublicReadCacheRequest(
      new Request("https://api.pirate.test/feed/home/videos/public?locale=en&sort=best"),
    )).toBe(true)
  })

  test("does not cache authenticated video feed requests", () => {
    expect(isPublicReadCacheRequest(
      new Request("https://api.pirate.test/feed/home/videos?locale=en"),
    )).toBe(false)
  })
})
