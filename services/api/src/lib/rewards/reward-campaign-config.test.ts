import { describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import { HttpError } from "../errors"
import { resolveRewardCampaignConfig } from "./reward-campaign-config"

function configuredEnv(overrides: Partial<Env> = {}): Env {
  return {
    REWARDS_CAMPAIGNS_ENABLED: "true",
    REWARDS_CAMPAIGN_CHAIN_ID: "84532",
    REWARDS_CAMPAIGN_USDC_TOKEN_ADDRESS: "0x1000000000000000000000000000000000000001",
    REWARDS_CAMPAIGN_TREASURY_ADDRESS: "0x2000000000000000000000000000000000000002",
    REWARDS_CAMPAIGN_RPC_URL: "https://base-sepolia.example.test",
    REWARDS_CAMPAIGN_QUOTE_TTL_SECONDS: "900",
    REWARDS_CAMPAIGN_MIN_BUDGET_CENTS: "1000",
    REWARDS_CAMPAIGN_MAX_BUDGET_CENTS: "1000000",
    REWARDS_CAMPAIGN_MAX_REWARD_CENTS: "1000",
    REWARDS_CAMPAIGN_MIN_DURATION_SECONDS: "3600",
    REWARDS_CAMPAIGN_MAX_DURATION_SECONDS: "7776000",
    ...overrides,
  } as Env
}

describe("reward campaign config", () => {
  test("requires the literal campaigns flag", () => {
    expect(resolveRewardCampaignConfig({ REWARDS_CAMPAIGNS_ENABLED: "1" } as Env).enabled).toBe(false)
    expect(resolveRewardCampaignConfig({ REWARDS_ENABLED: "true" } as Env).enabled).toBe(false)
  })

  test("resolves a fully configured Base USDC campaign rail", () => {
    expect(resolveRewardCampaignConfig(configuredEnv())).toMatchObject({
      enabled: true,
      chainId: 84532,
      quoteTtlSeconds: 900,
      minBudgetCents: 1000,
      maxBudgetCents: 1000000,
    })
  })

  test("fails closed when an enabled rail is incomplete or inconsistent", () => {
    for (const env of [
      configuredEnv({ REWARDS_CAMPAIGN_TREASURY_ADDRESS: undefined }),
      configuredEnv({ REWARDS_CAMPAIGN_RPC_URL: "http://unsafe.example.test" }),
      configuredEnv({ REWARDS_CAMPAIGN_CHAIN_ID: "1" }),
      configuredEnv({ REWARDS_CAMPAIGN_MIN_BUDGET_CENTS: "2000", REWARDS_CAMPAIGN_MAX_BUDGET_CENTS: "1000" }),
    ]) {
      expect(() => resolveRewardCampaignConfig(env)).toThrow(HttpError)
    }
  })
})
