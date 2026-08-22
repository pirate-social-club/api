import { describe, expect, test } from "bun:test"

import {
  configuredCorsOrigin,
  isAllowedHnsHttpReadOrigin,
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

  test("allows only activation-authorized HNS apex and app origins", () => {
    expect(configuredCorsOrigin("https://dankmeme", {
      CORS_ALLOWED_ORIGINS: "https://pirate.sc",
    })).toBeNull()
    expect(configuredCorsOrigin("https://app.dankmeme", {
      CORS_ALLOWED_ORIGINS: "https://pirate.sc",
    })).toBeNull()
    expect(configuredCorsOrigin("https://dankmeme", {
      CORS_ALLOWED_ORIGINS: "https://pirate.sc",
    }, true)).toBe("https://dankmeme")
    expect(configuredCorsOrigin("https://app.dankmeme", {
      CORS_ALLOWED_ORIGINS: "https://pirate.sc",
    }, true)).toBe("https://app.dankmeme")
    expect(configuredCorsOrigin("https://xn--pokmon-dva", {
      CORS_ALLOWED_ORIGINS: "https://pirate.sc",
    })).toBeNull()
    expect(configuredCorsOrigin("https://app.xn--pokmon-dva", {
      CORS_ALLOWED_ORIGINS: "https://pirate.sc",
    }, true)).toBe("https://app.xn--pokmon-dva")
  })

  test("does not trust unactivated roots or arbitrary nested origins", () => {
    expect(configuredCorsOrigin("https://app.dankmeme", {
      CORS_ALLOWED_ORIGINS: "https://pirate.sc",
    })).toBeNull()
    expect(configuredCorsOrigin("https://dankmeme", {
      CORS_ALLOWED_ORIGINS: "https://pirate.sc",
    })).toBeNull()
    expect(configuredCorsOrigin("https://www.dankmeme", {
      CORS_ALLOWED_ORIGINS: "https://pirate.sc",
    })).toBeNull()
    expect(configuredCorsOrigin("https://app.dankmeme.example", {
      CORS_ALLOWED_ORIGINS: "https://pirate.sc",
    })).toBeNull()
  })

  test("does not trust arbitrary single-label HTTPS origins", () => {
    expect(configuredCorsOrigin("https://evil", {
      CORS_ALLOWED_ORIGINS: "https://pirate.sc",
    })).toBeNull()
  })

  test("allows only anonymous safe reads from canonical HTTP HNS origins", () => {
    expect(isAllowedHnsHttpReadOrigin("http://app.pirate")).toBe(true)
    expect(isAllowedHnsHttpReadOrigin("http://king.bitcoin")).toBe(false)
    expect(isAllowedHnsHttpReadOrigin("http://app.dankmeme")).toBe(false)
    expect(isAllowedHnsHttpReadOrigin("https://app.pirate")).toBe(false)
    expect(isAllowedHnsHttpReadOrigin("http://app.pirate:8080")).toBe(false)
    expect(isAllowedHnsHttpReadOrigin("http://dankmeme", true)).toBe(true)
    expect(isAllowedHnsHttpReadOrigin("http://app.dankmeme", true)).toBe(true)
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
