import { describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import {
  assertRewardCampaignSettlementReadiness,
  rewardFundingRefundsEnabled,
} from "./reward-campaign-settlement-readiness"

const PRIVATE_KEY = "0x7000000000000000000000000000000000000000000000000000000000000007"
const OPERATOR = "0xCb23683A41ec98F506B67D89dEAF0Bb52ACC97A6"
const TOKEN = "0x1000000000000000000000000000000000000001"

function readyEnv(overrides: Partial<Env> = {}): Env {
  return {
    REWARDS_CAMPAIGN_CHAIN_ID: "84532",
    REWARDS_CAMPAIGN_USDC_TOKEN_ADDRESS: TOKEN,
    REWARDS_CAMPAIGN_TREASURY_ADDRESS: OPERATOR,
    REWARDS_CAMPAIGN_RPC_URL: "https://campaign.example.test",
    PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS: OPERATOR,
    PIRATE_REWARDS_SETTLEMENT_OPERATOR_PRIVATE_KEY: PRIVATE_KEY,
    PIRATE_REWARDS_SETTLEMENT_RPC_URL: "https://settlement.example.test",
    PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "84532",
    PIRATE_REWARDS_SETTLEMENT_USDC_TOKEN_ADDRESS: TOKEN,
    PIRATE_REWARDS_SETTLEMENT_ALLOW_TOKEN_OVERRIDE: "true",
    ...overrides,
  } as Env
}

describe("reward campaign settlement readiness", () => {
  test("accepts one wallet and one asset across campaign custody and settlement", () => {
    expect(assertRewardCampaignSettlementReadiness(readyEnv())).toMatchObject({
      chainId: 84532,
      tokenAddress: TOKEN,
      treasuryAddress: OPERATOR,
    })
  })

  test("fails closed without the signer key or when the signer does not own custody", () => {
    expect(() => assertRewardCampaignSettlementReadiness(readyEnv({
      PIRATE_REWARDS_SETTLEMENT_OPERATOR_PRIVATE_KEY: undefined,
    }))).toThrow("Reward campaign settlement is unavailable")
    expect(() => assertRewardCampaignSettlementReadiness(readyEnv({
      REWARDS_CAMPAIGN_TREASURY_ADDRESS: "0x2000000000000000000000000000000000000002",
    }))).toThrow("Reward campaign settlement is unavailable")
  })

  test("fails closed when campaign and settlement assets differ", () => {
    expect(() => assertRewardCampaignSettlementReadiness(readyEnv({
      PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "8453",
    }))).toThrow("Reward campaign settlement is unavailable")
    expect(() => assertRewardCampaignSettlementReadiness(readyEnv({
      PIRATE_REWARDS_SETTLEMENT_USDC_TOKEN_ADDRESS: "0x3000000000000000000000000000000000000003",
    }))).toThrow("Reward campaign settlement is unavailable")
  })

  test("lets an explicit refund drain flag survive campaign and payout shutdown", () => {
    expect(rewardFundingRefundsEnabled({
      REWARDS_CAMPAIGNS_ENABLED: "false",
      REWARDS_PAYOUTS_ENABLED: "false",
      REWARDS_REFUNDS_ENABLED: "true",
    } as Env)).toBe(true)
    expect(rewardFundingRefundsEnabled({ REWARDS_PAYOUTS_ENABLED: "true" } as Env)).toBe(true)
    expect(rewardFundingRefundsEnabled({
      REWARDS_PAYOUTS_ENABLED: "true",
      REWARDS_REFUNDS_ENABLED: "false",
    } as Env)).toBe(false)
  })
})
