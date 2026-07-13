import { describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import type { Client } from "../sql-client"
import { monitorRewardCampaigns } from "./reward-campaign-monitor"

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

function queryCountingClient(onQuery: () => void): Client {
  return {
    execute: async () => {
      onQuery()
      throw new Error("unexpected database query")
    },
  } as unknown as Client
}

describe("reward campaign monitor enable gate", () => {
  test("disabled campaigns return silently without querying unprovisioned tables", async () => {
    let queries = 0
    const summary = await monitorRewardCampaigns({
      env: {} as Env,
      client: queryCountingClient(() => { queries += 1 }),
    })

    expect(queries).toBe(0)
    expect(summary).toMatchObject({
      enabled: false,
      scanned: 0,
      liveness_stale: false,
      coverage_stale: false,
      wholly_blind: false,
      partial_finality_degraded: false,
      incidents: [],
    })
  })

  test("enabled campaigns still fail before querying when alert ownership is missing", async () => {
    let queries = 0
    await expect(monitorRewardCampaigns({
      env: configuredEnv(),
      client: queryCountingClient(() => { queries += 1 }),
    })).rejects.toThrow("reward_campaign_alert_delivery_not_configured")

    expect(queries).toBe(0)
  })
})
