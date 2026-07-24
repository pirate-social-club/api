import { describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import {
  resolveRewardVaultLitConfig,
  resolveRewardsSettlementBackend,
  rewardVaultSigningDeadline,
} from "./reward-vault-lit-config"

const VAULT = "0x1000000000000000000000000000000000000001"

function env(overrides: Partial<Env> = {}): Env {
  return {
    PIRATE_REWARDS_SETTLEMENT_BACKEND: "lit_vault",
    REWARDS_TREASURY_VAULT_ADDRESS: VAULT,
    REWARDS_TREASURY_VAULT_POLICY_VERSION: "7",
    LIT_REWARDS_USAGE_API_KEY: "usage-secret",
    LIT_REWARDS_ACTION_IPFS_ID: "QmPinned",
    ...overrides,
  } as Env
}

describe("reward vault Lit config", () => {
  test("keeps local as the compatibility default", () => {
    expect(resolveRewardsSettlementBackend({} as Env)).toBe("local")
    expect(resolveRewardsSettlementBackend(env())).toBe("lit_vault")
    expect(() => resolveRewardsSettlementBackend(env({
      PIRATE_REWARDS_SETTLEMENT_BACKEND: "code",
    }))).toThrow("must be local or lit_vault")
  })

  test("resolves the pinned production execution inputs", () => {
    expect(resolveRewardVaultLitConfig(env())).toEqual({
      apiUrl: "https://api.chipotle.litprotocol.com",
      usageApiKey: "usage-secret",
      actionIpfsId: "QmPinned",
      vaultAddress: VAULT,
      policyVersion: 7n,
      requestTimeoutMs: 20_000,
      requestMaxAttempts: 3,
      signingDeadlineSeconds: 300,
    })
  })

  test("fails closed on missing credentials, CID, vault, or canonical policy version", () => {
    expect(() => resolveRewardVaultLitConfig(env({ LIT_REWARDS_USAGE_API_KEY: "" })))
      .toThrow("LIT_REWARDS_USAGE_API_KEY is required")
    expect(() => resolveRewardVaultLitConfig(env({ LIT_REWARDS_ACTION_IPFS_ID: "" })))
      .toThrow("LIT_REWARDS_ACTION_IPFS_ID is required")
    expect(() => resolveRewardVaultLitConfig(env({ REWARDS_TREASURY_VAULT_ADDRESS: "" })))
      .toThrow("REWARDS_TREASURY_VAULT_ADDRESS is invalid")
    expect(() => resolveRewardVaultLitConfig(env({
      REWARDS_TREASURY_VAULT_POLICY_VERSION: "07",
    }))).toThrow("must be a positive integer")
  })

  test("computes a fresh deadline from the signing-attempt clock", () => {
    expect(rewardVaultSigningDeadline(2_000_000_999_999, 300)).toBe(2_000_001_299n)
    expect(rewardVaultSigningDeadline(2_000_100_000_000, 300)).toBe(2_000_100_300n)
  })
})
