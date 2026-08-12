import { describe, expect, test } from "bun:test"

import { configuredCorsOrigin, importedHnsAppRoot, importedHnsRootLabel } from "./allowed-origins"

describe("HNS activation CORS origins", () => {
  test("parses only dashboard-compatible imported HNS app origins", () => {
    expect(importedHnsAppRoot("https://app.new-root")).toBe("new-root")
    expect(importedHnsAppRoot("https://app.new-root:8443")).toBe(null)
    expect(importedHnsAppRoot("http://app.new-root")).toBe(null)
    expect(importedHnsAppRoot("https://profile.new-root")).toBe(null)
    expect(importedHnsRootLabel("https://new-root")).toBe("new-root")
    expect(importedHnsRootLabel("https://app.new-root")).toBe(null)
  })

  test("denies arbitrary imported apex and app origins without activation", () => {
    expect(configuredCorsOrigin("https://unactivated-root", undefined)).toBe(null)
    expect(configuredCorsOrigin("https://app.unactivated-root", undefined)).toBe(null)
    expect(configuredCorsOrigin("https://unactivated-root", undefined, true)).toBe(
      "https://unactivated-root",
    )
    expect(configuredCorsOrigin("https://app.unactivated-root", undefined, true)).toBe(
      "https://app.unactivated-root",
    )
  })

  test("keeps static Pirate and configured ICANN origins unchanged", () => {
    expect(configuredCorsOrigin("https://app.pirate", undefined)).toBe("https://app.pirate")
    expect(configuredCorsOrigin("https://pirate.sc", {
      CORS_ALLOWED_ORIGINS: "https://pirate.sc",
    })).toBe("https://pirate.sc")
  })
})
