import { describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import { getRewardCampaignCapabilities } from "./reward-campaign-capabilities"

const enabledEnv = {
  REWARDS_CAMPAIGNS_ENABLED: "true",
  REWARDS_ACCRUAL_ENABLED: "true",
  REWARDS_PAYOUTS_ENABLED: "true",
  REWARDS_CAMPAIGN_CHAIN_ID: "84532",
  REWARDS_CAMPAIGN_USDC_TOKEN_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  REWARDS_CAMPAIGN_TREASURY_ADDRESS: "0xCb23683A41ec98F506B67D89dEAF0Bb52ACC97A6",
  REWARDS_CAMPAIGN_RPC_URL: "https://sepolia.base.org",
  REWARDS_CAMPAIGN_QUOTE_TTL_SECONDS: "900",
  REWARDS_CAMPAIGN_MIN_BUDGET_CENTS: "100",
  REWARDS_CAMPAIGN_MAX_BUDGET_CENTS: "10000",
  REWARDS_CAMPAIGN_MAX_REWARD_CENTS: "100",
  REWARDS_CAMPAIGN_MIN_DURATION_SECONDS: "86400",
  REWARDS_CAMPAIGN_MAX_DURATION_SECONDS: "7776000",
  PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS: "0xCb23683A41ec98F506B67D89dEAF0Bb52ACC97A6",
  PIRATE_REWARDS_SETTLEMENT_OPERATOR_PRIVATE_KEY: "0x7000000000000000000000000000000000000000000000000000000000000007",
  PIRATE_REWARDS_SETTLEMENT_RPC_URL: "https://sepolia.base.org",
  PIRATE_REWARDS_SETTLEMENT_CHAIN_ID: "84532",
  PIRATE_REWARDS_SETTLEMENT_USDC_TOKEN_ADDRESS: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  PIRATE_REWARDS_SETTLEMENT_ALLOW_TOKEN_OVERRIDE: "false",
} as unknown as Env

describe("getRewardCampaignCapabilities", () => {
  test("reports the live guardrails when campaigns are enabled", () => {
    const capabilities = getRewardCampaignCapabilities(enabledEnv)
    expect(capabilities.enabled).toBe(true)
    expect(capabilities.min_budget_cents).toBe(100)
    expect(capabilities.max_budget_cents).toBe(10_000)
    expect(capabilities.max_reward_cents).toBe(100)
    expect(capabilities.chain_id).toBe(84_532)
    expect(capabilities.eligible_activities).toEqual(["study", "karaoke", "either"])
  })

  test("never exposes the campaign RPC URL or the treasury address", () => {
    // The RPC URL may carry a provider credential, and the scoped funding quote
    // is the only place a treasury address should ever appear.
    const serialized = JSON.stringify(getRewardCampaignCapabilities(enabledEnv))
    expect(serialized).not.toContain("sepolia.base.org")
    expect(serialized).not.toContain("0xCb23683A41ec98F506B67D89dEAF0Bb52ACC97A6")
    expect(serialized).not.toContain("rpc")
    expect(serialized).not.toContain("treasury")
  })

  test("the pilot duration is 30 days and sits inside the configured guardrails", () => {
    const capabilities = getRewardCampaignCapabilities(enabledEnv)
    expect(capabilities.default_duration_seconds).toBe(30 * 24 * 60 * 60)
    expect(capabilities.default_duration_seconds).toBeGreaterThanOrEqual(capabilities.min_duration_seconds)
    expect(capabilities.default_duration_seconds).toBeLessThanOrEqual(capabilities.max_duration_seconds)
  })

  test("clamps the pilot duration when the configured maximum is shorter", () => {
    // A client must never be handed a duration the create route would reject.
    const capabilities = getRewardCampaignCapabilities({
      ...enabledEnv,
      REWARDS_CAMPAIGN_MAX_DURATION_SECONDS: "604800",
    } as unknown as Env)
    expect(capabilities.default_duration_seconds).toBe(604_800)
    expect(capabilities.default_duration_seconds).toBeLessThanOrEqual(capabilities.max_duration_seconds)
  })

  test("clamps the pilot duration up when the configured minimum is longer", () => {
    const capabilities = getRewardCampaignCapabilities({
      ...enabledEnv,
      REWARDS_CAMPAIGN_MIN_DURATION_SECONDS: "5184000",
    } as unknown as Env)
    expect(capabilities.default_duration_seconds).toBe(5_184_000)
    expect(capabilities.default_duration_seconds).toBeGreaterThanOrEqual(capabilities.min_duration_seconds)
  })

  test("reports disabled with zeroed guardrails when campaigns are dark", () => {
    // Production state today: no reward configuration at all.
    const capabilities = getRewardCampaignCapabilities({} as Env)
    expect(capabilities.enabled).toBe(false)
    expect(capabilities.max_budget_cents).toBe(0)
    expect(capabilities.chain_id).toBe(0)
    expect(capabilities.eligible_activities).toEqual([])
  })

  test("reports disabled rather than throwing when the configuration is invalid", () => {
    // A capability probe must not become a 5xx: the client hides the entry point.
    const capabilities = getRewardCampaignCapabilities({
      REWARDS_CAMPAIGNS_ENABLED: "true",
      REWARDS_CAMPAIGN_RPC_URL: "not-a-url",
    } as unknown as Env)
    expect(capabilities.enabled).toBe(false)
  })

  test("reports disabled when campaign custody is not settlement-ready", () => {
    expect(getRewardCampaignCapabilities({
      ...enabledEnv,
      PIRATE_REWARDS_SETTLEMENT_OPERATOR_PRIVATE_KEY: undefined,
    } as unknown as Env).enabled).toBe(false)
  })
})
