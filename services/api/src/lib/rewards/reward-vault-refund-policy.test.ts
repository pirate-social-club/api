import { describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import {
  assertContributionWithinRefundPolicy,
  resolveRewardVaultRefundPolicyConfig,
} from "./reward-vault-refund-policy"

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

  test("does not require parked Lit policy configuration for the EOA vault backend", () => {
    const config = resolveRewardVaultRefundPolicyConfig({
      PIRATE_REWARDS_SETTLEMENT_BACKEND: "eoa_vault",
      REWARDS_TREASURY_VAULT_ADDRESS: "0x0000000000000000000000000000000000000001",
      REWARDS_TREASURY_VAULT_POLICY_VERSION: "2",
      LIT_REWARDS_ACTION_POLICY_VERSION: "1",
      LIT_REWARDS_MAX_FEE_PER_GAS_WEI: "1000000000",
      LIT_REWARDS_MAX_PRIORITY_FEE_PER_GAS_WEI: "100000000",
      LIT_REWARDS_MAX_GAS_LIMIT: "200000",
    } as unknown as Env)

    expect(config?.policyVersion).toBe(2n)
  })
})
