import { describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import type { Client } from "../sql-client"
import { monitorRewardCampaigns, rewardCampaignAccountingAlertDetails } from "./reward-campaign-monitor"

function configuredEnv(overrides: Partial<Env> = {}): Env {
  return {
    REWARDS_CAMPAIGNS_ENABLED: "true",
    REWARDS_ACCRUAL_ENABLED: "true",
    REWARDS_PAYOUTS_ENABLED: "true",
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

describe("reward campaign incident alert evidence", () => {
  test("reports signed stored-minus-computed accounting deltas without number coercion", () => {
    expect(rewardCampaignAccountingAlertDetails({
      stored_funded_cents: "100",
      computed_funded_cents: "100",
      stored_reserved_cents: "1",
      computed_reserved_cents: "0",
      stored_credited_cents: "0",
      computed_credited_cents: "2",
    })).toEqual({
      stored_funded_cents: "100",
      computed_funded_cents: "100",
      funded_delta_cents: "0",
      stored_reserved_cents: "1",
      computed_reserved_cents: "0",
      reserved_delta_cents: "1",
      stored_credited_cents: "0",
      computed_credited_cents: "2",
      credited_delta_cents: "-2",
    })
  })
})
