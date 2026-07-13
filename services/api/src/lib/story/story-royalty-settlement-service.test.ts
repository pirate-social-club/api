import { describe, expect, test } from "bun:test"
import {
  isRetryableStoryRoyaltyPreflightError,
  withStoryRoyaltyPreflightRetry,
} from "./story-royalty-settlement-service"

describe("Story royalty preflight retry", () => {
  test("retries a transient preflight revert until claimable revenue is visible", async () => {
    let attempts = 0
    const sleeps: number[] = []

    const result = await withStoryRoyaltyPreflightRetry(async () => {
      attempts += 1
      if (attempts < 3) {
        throw new Error("RPC Request failed: eth_fillTransaction: execution reverted")
      }
      return "0xtransfer"
    }, {
      maxAttempts: 4,
      delayMs: 25,
      sleep: async (ms) => { sleeps.push(ms) },
    })

    expect(result).toBe("0xtransfer")
    expect(attempts).toBe(3)
    expect(sleeps).toEqual([25, 25])
  })

  test("does not retry an ambiguous post-broadcast RPC failure", async () => {
    let attempts = 0
    const failure = new Error("RPC timeout while waiting for transaction hash")

    await expect(withStoryRoyaltyPreflightRetry(async () => {
      attempts += 1
      throw failure
    }, {
      sleep: async () => undefined,
    })).rejects.toBe(failure)

    expect(attempts).toBe(1)
  })

  test("recognizes only simulation reverts", () => {
    expect(isRetryableStoryRoyaltyPreflightError(
      new Error("eth_call failed: execution reverted"),
    )).toBe(true)
    expect(isRetryableStoryRoyaltyPreflightError(
      new Error('Failed to pay royalty on behalf: aggregate3Value reverted; RPC method "eth_fillTransaction"; execution reverted'),
    )).toBe(true)
    expect(isRetryableStoryRoyaltyPreflightError(
      new Error("writeContract failed: execution reverted"),
    )).toBe(false)
  })
})
