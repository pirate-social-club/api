import { describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import type { Client } from "../sql-client"
import { reconcileConfirmingRewardCampaignFunding } from "./reward-funding-confirmation-reconciler"

const ENV = {
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
} as Env

function clientWithCandidates(rows: Array<Record<string, unknown>>): Client {
  return {
    execute: async () => ({ rows, rowsAffected: 0 }),
  } as unknown as Client
}

function funding(status: "confirmed" | "confirming" | "failed") {
  return {
    id: "rcf_test",
    object: "reward_campaign_funding_quote" as const,
    campaign: "rcp_test",
    funder: "usr_test",
    chain_id: 84532,
    token_address: "0x1000000000000000000000000000000000000001",
    amount_cents: 1000,
    amount_atomic: "10000000",
    sender_address: "0x3000000000000000000000000000000000000003",
    treasury_address: "0x2000000000000000000000000000000000000002",
    status,
    expires_at: 1,
    created: 1,
  }
}

describe("confirming reward funding reconciler", () => {
  test("does not query campaign tables while campaigns are disabled", async () => {
    let queried = false
    const summary = await reconcileConfirmingRewardCampaignFunding({
      env: {} as Env,
      client: {
        execute: async () => {
          queried = true
          throw new Error("unexpected query")
        },
      } as unknown as Client,
    })

    expect(queried).toBe(false)
    expect(summary).toEqual({
      enabled: false,
      scanned: 0,
      confirmed: 0,
      pending: 0,
      terminal: 0,
      errors: 0,
    })
  })

  test("replays each stored hash and isolates per-effect failures", async () => {
    const candidates = [
      {
        reward_campaign_funding_effect_id: "rcf_confirmed",
        reward_campaign_id: "rcp_confirmed",
        funder_user_id: "usr_confirmed",
        tx_hash: `0x${"a".repeat(64)}`,
      },
      {
        reward_campaign_funding_effect_id: "rcf_pending",
        reward_campaign_id: "rcp_pending",
        funder_user_id: "usr_pending",
        tx_hash: `0x${"b".repeat(64)}`,
      },
      {
        reward_campaign_funding_effect_id: "rcf_failed",
        reward_campaign_id: "rcp_failed",
        funder_user_id: "usr_failed",
        tx_hash: `0x${"c".repeat(64)}`,
      },
      {
        reward_campaign_funding_effect_id: "rcf_error",
        reward_campaign_id: "rcp_error",
        funder_user_id: "usr_error",
        tx_hash: `0x${"d".repeat(64)}`,
      },
    ]
    const seen: string[] = []
    const summary = await reconcileConfirmingRewardCampaignFunding({
      env: ENV,
      client: clientWithCandidates(candidates),
      limit: 25,
      now: "2026-07-29T17:00:00.000Z",
      confirm: async (input) => {
        seen.push(`${input.fundingId}:${input.txHash}`)
        if (input.fundingId === "rcf_confirmed") return funding("confirmed")
        if (input.fundingId === "rcf_pending") return funding("confirming")
        if (input.fundingId === "rcf_failed") return funding("failed")
        throw new Error("rpc unavailable")
      },
    })

    expect(seen).toEqual(candidates.map((candidate) => (
      `${candidate.reward_campaign_funding_effect_id}:${candidate.tx_hash}`
    )))
    expect(summary).toEqual({
      enabled: true,
      scanned: 4,
      confirmed: 1,
      pending: 1,
      terminal: 1,
      errors: 1,
    })
  })
})
