import { describe, expect, test } from "bun:test"

import { assertContributionWithinRefundPolicy } from "./reward-vault-refund-policy"

describe("reward vault refund admission policy", () => {
  const observation = {
    policyVersion: 7n,
    maxRefundAtomic: 1_000_000n,
    blockNumber: 123,
    observedAt: "2026-07-24T00:00:00.000Z",
  }

  test("accepts a contribution exactly at the observed maxRefund", () => {
    expect(() => assertContributionWithinRefundPolicy(100, observation)).not.toThrow()
  })

  test("rejects a contribution whose atomic amount exceeds maxRefund", () => {
    expect(() => assertContributionWithinRefundPolicy(101, observation))
      .toThrow("Reward contribution exceeds the current single-refund limit")
  })

  test("does not impose a vault limit in the local backend", () => {
    expect(() => assertContributionWithinRefundPolicy(10_000_000, null)).not.toThrow()
  })
})
