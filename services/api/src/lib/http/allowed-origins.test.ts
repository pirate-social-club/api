import { describe, expect, test } from "bun:test"

import { configuredCorsOrigin, importedHnsAppRoot } from "./allowed-origins"

describe("HNS wallet CORS origins", () => {
  test("parses only dashboard-compatible imported HNS app origins", () => {
    expect(importedHnsAppRoot("https://app.new-root")).toBe("new-root")
    expect(importedHnsAppRoot("https://app.new-root:8443")).toBe(null)
    expect(importedHnsAppRoot("http://app.new-root")).toBe(null)
    expect(importedHnsAppRoot("https://profile.new-root")).toBe(null)
  })

  test("denies arbitrary imported app origins without durable authority", () => {
    expect(configuredCorsOrigin("https://app.unactivated-root", undefined)).toBe(null)
    expect(configuredCorsOrigin("https://app.unactivated-root", undefined, true)).toBe(
      "https://app.unactivated-root",
    )
  })

  test("keeps the two deployed origins during the dual-read rollout", () => {
    expect(configuredCorsOrigin("https://app.dankmeme", undefined)).toBe("https://app.dankmeme")
    expect(configuredCorsOrigin("https://app.jazleeuw", undefined)).toBe("https://app.jazleeuw")
  })

  test("keeps static Pirate and configured ICANN origins unchanged", () => {
    expect(configuredCorsOrigin("https://app.pirate", undefined)).toBe("https://app.pirate")
    expect(configuredCorsOrigin("https://pirate.sc", {
      CORS_ALLOWED_ORIGINS: "https://pirate.sc",
    })).toBe("https://pirate.sc")
  })
})
