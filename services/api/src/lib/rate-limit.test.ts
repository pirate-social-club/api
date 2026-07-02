import { describe, expect, test } from "bun:test"

import { enforceRateLimit } from "./rate-limit"

describe("enforceRateLimit", () => {
  test("allows the request when the limiter reports success", async () => {
    const limiter = { limit: async () => ({ success: true }) }
    await expect(enforceRateLimit(limiter, "link-preview:u1", "slow down")).resolves.toBeUndefined()
  })

  test("throws a 429 rate_limited error when the limit is exceeded", async () => {
    const limiter = { limit: async () => ({ success: false }) }
    await expect(enforceRateLimit(limiter, "link-preview:u1", "slow down")).rejects.toThrow("slow down")
  })

  test("fails OPEN when the binding is absent (never breaks the request path)", async () => {
    await expect(enforceRateLimit(undefined, "link-preview:u1", "slow down")).resolves.toBeUndefined()
    await expect(enforceRateLimit(null, "link-preview:u1", "slow down")).resolves.toBeUndefined()
  })

  test("passes the composed key through to the limiter", async () => {
    let seen = ""
    const limiter = {
      limit: async ({ key }: { key: string }) => {
        seen = key
        return { success: true }
      },
    }
    await enforceRateLimit(limiter, "link-preview:user_123", "slow down")
    expect(seen).toBe("link-preview:user_123")
  })
})
