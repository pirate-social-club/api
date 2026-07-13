import { describe, expect, test } from "bun:test"
import {
  isRetryableDirectTxNonceCollisionError,
  withDirectTxNonceCollisionRetry,
} from "./evm-direct-tx"

describe("direct transaction nonce-collision retry", () => {
  test("retries a rejected replacement after another transaction wins the nonce", async () => {
    let attempts = 0
    const sleeps: number[] = []

    const result = await withDirectTxNonceCollisionRetry(async () => {
      attempts += 1
      if (attempts < 3) {
        throw new Error("replacement fee too low: replacement transaction underpriced")
      }
      return "0xhash"
    }, {
      maxAttempts: 4,
      delayMs: 25,
      sleep: async (ms) => { sleeps.push(ms) },
    })

    expect(result).toBe("0xhash")
    expect(attempts).toBe(3)
    expect(sleeps).toEqual([25, 25])
  })

  test("recognizes nested replacement-underpriced RPC errors", () => {
    expect(isRetryableDirectTxNonceCollisionError({
      message: "could not coalesce error",
      error: { message: "replacement transaction underpriced" },
    })).toBe(true)
  })

  test("does not retry ambiguous transport or post-broadcast failures", async () => {
    let attempts = 0
    const failure = new Error("timeout while waiting for transaction receipt")

    await expect(withDirectTxNonceCollisionRetry(async () => {
      attempts += 1
      throw failure
    }, {
      sleep: async () => undefined,
    })).rejects.toBe(failure)

    expect(attempts).toBe(1)
  })
})
