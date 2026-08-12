import { describe, expect, test } from "bun:test"

import type { Env } from "../../../env"
import {
  assertRewardsCampaignTreasuryMatchesSettlementOperator,
  resolveRewardsSettlementBroadcastRpcUrl,
  resolveRewardsSettlementOperatorAddress,
  resolveRewardsSettlementRpcUrlForChain,
} from "./booking-chain-config"

const RAW_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
const PKP = "0x2000000000000000000000000000000000000002"
const VAULT = "0x1000000000000000000000000000000000000001"

function env(overrides: Partial<Env> = {}): Env {
  return {
    PIRATE_REWARDS_SETTLEMENT_BACKEND: "lit_vault",
    PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS: PKP,
    // May coexist during rollout, but must be ignored by lit_vault.
    PIRATE_REWARDS_SETTLEMENT_OPERATOR_PRIVATE_KEY: RAW_KEY,
    REWARDS_CAMPAIGN_TREASURY_ADDRESS: VAULT,
    REWARDS_TREASURY_VAULT_ADDRESS: VAULT,
    ...overrides,
  } as Env
}

describe("rewards vault custody/signer split", () => {
  test("uses the explicit PKP address without comparing a transitional raw key", () => {
    expect(resolveRewardsSettlementOperatorAddress(env())).toBe(PKP)
    expect(() => assertRewardsCampaignTreasuryMatchesSettlementOperator(env())).not.toThrow()
  })

  test("requires campaign custody to equal the vault and differ from the signer", () => {
    expect(() => assertRewardsCampaignTreasuryMatchesSettlementOperator(env({
      REWARDS_CAMPAIGN_TREASURY_ADDRESS: "0x3000000000000000000000000000000000000003",
    }))).toThrow("must match the rewards treasury vault")
    expect(() => assertRewardsCampaignTreasuryMatchesSettlementOperator(env({
      REWARDS_CAMPAIGN_TREASURY_ADDRESS: PKP,
      REWARDS_TREASURY_VAULT_ADDRESS: PKP,
    }))).toThrow("must be distinct")
  })

  test("resolves historical funding RPCs from the persisted chain", () => {
    const configured = env({
      PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "8453",
      PIRATE_REWARDS_SETTLEMENT_RPC_URL: "https://current-mainnet.example",
      BASE_MAINNET_RPC_URL: "https://base-mainnet.example",
      BASE_SEPOLIA_RPC_URL: "https://base-sepolia.example",
    })
    expect(resolveRewardsSettlementRpcUrlForChain(configured, 8453)).toBe("https://current-mainnet.example")
    expect(resolveRewardsSettlementRpcUrlForChain(configured, 84532)).toBe("https://base-sepolia.example")
  })

  test("uses a dedicated rewards broadcast RPC without changing the keyed read RPC", () => {
    const configured = env({
      PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "8453",
      PIRATE_REWARDS_SETTLEMENT_BROADCAST_RPC_URL: "https://broadcast-mainnet.example",
      BASE_MAINNET_RPC_URL: "https://keyed-mainnet.example",
    })
    expect(resolveRewardsSettlementBroadcastRpcUrl(configured)).toBe("https://broadcast-mainnet.example")
    expect(resolveRewardsSettlementBroadcastRpcUrl({
      ...configured,
      PIRATE_REWARDS_SETTLEMENT_BROADCAST_RPC_URL: undefined,
    } as Env)).toBe("https://keyed-mainnet.example")
  })
})
