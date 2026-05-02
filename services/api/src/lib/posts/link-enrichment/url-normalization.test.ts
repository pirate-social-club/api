import { describe, expect, test } from "bun:test"
import { normalizeLinkUrl } from "./url-normalization"

describe("normalizeLinkUrl", () => {
  test("normalizes host, removes fragments, sorts query params, and drops tracking params", () => {
    expect(normalizeLinkUrl(
      "HTTPS://Example.COM/story/?utm_source=x&b=2&a=1#comments",
    )).toBe("https://example.com/story?a=1&b=2")
  })

  test("rejects non-http URLs", () => {
    expect(normalizeLinkUrl("mailto:hello@example.com")).toBeNull()
  })
})

