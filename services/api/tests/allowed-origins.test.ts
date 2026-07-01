import { describe, expect, test } from "bun:test"

import {
  configuredCorsOrigin,
  isAllowedKaraokeWebSocketOrigin,
} from "../src/lib/http/allowed-origins"

describe("allowed origins", () => {
  test("allows the native Android karaoke origin for karaoke websocket upgrades", () => {
    expect(isAllowedKaraokeWebSocketOrigin("https://android.pirate.sc", {
      CORS_ALLOWED_ORIGINS: "https://pirate.sc",
      ENVIRONMENT: "production",
      PIRATE_WEB_PUBLIC_ORIGIN: "https://pirate.sc",
    })).toBe(true)
  })

  test("allows configured Android karaoke origin variants", () => {
    expect(isAllowedKaraokeWebSocketOrigin("https://android-staging.pirate.sc", {
      CORS_ALLOWED_ORIGINS: "https://staging.pirate.sc",
      ENVIRONMENT: "staging",
      PIRATE_ANDROID_KARAOKE_ORIGINS: "https://android-staging.pirate.sc",
      PIRATE_WEB_PUBLIC_ORIGIN: "https://staging.pirate.sc",
    })).toBe(true)
  })

  test("does not allow the Android karaoke origin for general CORS", () => {
    expect(configuredCorsOrigin("https://android.pirate.sc", {
      CORS_ALLOWED_ORIGINS: "https://pirate.sc",
    })).toBeNull()
  })

  test("rejects malformed or null karaoke origins", () => {
    const env = {
      CORS_ALLOWED_ORIGINS: "https://pirate.sc",
      ENVIRONMENT: "production",
      PIRATE_WEB_PUBLIC_ORIGIN: "https://pirate.sc",
    }

    expect(isAllowedKaraokeWebSocketOrigin(null, env)).toBe(false)
    expect(isAllowedKaraokeWebSocketOrigin("null", env)).toBe(false)
    expect(isAllowedKaraokeWebSocketOrigin("https://android.pirate.sc/path", env)).toBe(false)
  })
})
