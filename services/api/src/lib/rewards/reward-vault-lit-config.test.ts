import { describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import {
  resolveRewardVaultConfig,
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
    LIT_REWARDS_ACTION_POLICY_VERSION: "7",
    LIT_REWARDS_MAX_FEE_PER_GAS_WEI: "50000000000",
    LIT_REWARDS_MAX_PRIORITY_FEE_PER_GAS_WEI: "25000000000",
    LIT_REWARDS_MAX_GAS_LIMIT: "300000",
    ...overrides,
  } as Env
}

describe("reward vault Lit config", () => {
  test("keeps local as the compatibility default", () => {
    expect(resolveRewardsSettlementBackend({} as Env)).toBe("local")
    expect(resolveRewardsSettlementBackend(env())).toBe("lit_vault")
    expect(resolveRewardsSettlementBackend(env({
      PIRATE_REWARDS_SETTLEMENT_BACKEND: "eoa_vault",
    }))).toBe("eoa_vault")
    expect(() => resolveRewardsSettlementBackend(env({
      PIRATE_REWARDS_SETTLEMENT_BACKEND: "code",
    }))).toThrow("must be local, lit_vault, or eoa_vault")
  })

  test("resolves common vault policy without requiring Lit credentials", () => {
    expect(resolveRewardVaultConfig(env({
      PIRATE_REWARDS_SETTLEMENT_BACKEND: "eoa_vault",
      LIT_REWARDS_USAGE_API_KEY: undefined,
      LIT_REWARDS_ACTION_IPFS_ID: undefined,
    }))).toEqual({
      vaultAddress: VAULT,
      policyVersion: 7n,
      signingDeadlineSeconds: 300,
      maxFeePerGasWei: 50_000_000_000n,
      maxPriorityFeePerGasWei: 25_000_000_000n,
      maxGasLimit: 300_000n,
    })
  })

  test("resolves the pinned production execution inputs", () => {
    expect(resolveRewardVaultLitConfig(env())).toEqual({
      apiUrl: "https://api.chipotle.litprotocol.com",
      usageApiKey: "usage-secret",
      actionIpfsId: "QmPinned",
      actionPolicyVersion: 7n,
      vaultAddress: VAULT,
      policyVersion: 7n,
      requestTimeoutMs: 20_000,
      requestMaxAttempts: 1,
      signingDeadlineSeconds: 300,
      maxFeePerGasWei: 50_000_000_000n,
      maxPriorityFeePerGasWei: 25_000_000_000n,
      maxGasLimit: 300_000n,
    })
  })

  test("fails closed on missing credentials, CID, vault, or canonical policy version", () => {
    expect(() => resolveRewardVaultLitConfig(env({ LIT_REWARDS_USAGE_API_KEY: "" })))
      .toThrow("LIT_REWARDS_USAGE_API_KEY is required")
    expect(() => resolveRewardVaultLitConfig(env({ LIT_REWARDS_ACTION_IPFS_ID: "" })))
      .toThrow("LIT_REWARDS_ACTION_IPFS_ID is required")
    expect(() => resolveRewardVaultLitConfig(env({ LIT_REWARDS_ACTION_POLICY_VERSION: "8" })))
      .toThrow("must match REWARDS_TREASURY_VAULT_POLICY_VERSION")
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
