import { describe, expect, test } from "bun:test"

import { evaluateLease } from "./scheduled-cron-lease"

describe("evaluateLease", () => {
  test("acquires when no lease exists", () => {
    const d = evaluateLease(null, 1_000, "A", 100)
    expect(d.acquired).toBe(true)
    expect(d.lease).toEqual({ owner: "A", expiresAt: 1_100 })
  })

  test("denies when held by another owner and not expired", () => {
    const current = { owner: "A", expiresAt: 5_000 }
    const d = evaluateLease(current, 1_000, "B", 4_999)
    expect(d.acquired).toBe(false)
    expect(d.lease).toBe(current) // unchanged
  })

  test("acquires when the existing lease has expired (expiresAt <= now)", () => {
    const d = evaluateLease({ owner: "A", expiresAt: 5_000 }, 1_000, "B", 5_000)
    expect(d.acquired).toBe(true)
    expect(d.lease).toEqual({ owner: "B", expiresAt: 6_000 })
  })

  test("same owner renews even before expiry (new expiry from now + ttl)", () => {
    const d = evaluateLease({ owner: "A", expiresAt: 5_000 }, 1_000, "A", 4_500)
    expect(d.acquired).toBe(true)
    expect(d.lease).toEqual({ owner: "A", expiresAt: 5_500 })
  })
})
