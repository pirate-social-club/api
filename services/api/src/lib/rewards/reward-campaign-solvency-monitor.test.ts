import { describe, expect, mock, test } from "bun:test"

import type { Env } from "../../env"
import { captureScheduledWarning } from "../ops-alerts/scheduled"
import type { Client } from "../sql-client"
import {
  monitorRewardCampaignTreasurySolvency,
  readRewardCampaignLiability,
} from "./reward-campaign-solvency-monitor"

function clientWithRow(row: Record<string, unknown>): Client {
  return {
    execute: async () => ({ rows: [row], columns: [] }),
  } as unknown as Client
}

const env = {
  REWARDS_CAMPAIGN_CHAIN_ID: "84532",
  REWARDS_CAMPAIGN_USDC_TOKEN_ADDRESS: "0x1000000000000000000000000000000000000001",
  REWARDS_CAMPAIGN_TREASURY_ADDRESS: "0x2000000000000000000000000000000000000002",
  REWARDS_CAMPAIGN_RPC_URL: "https://base-sepolia.example.test",
} as Env

describe("reward campaign treasury solvency monitor", () => {
  test("combines future campaign inventory, learner balances, and exact pending refunds", async () => {
    const liability = await readRewardCampaignLiability(clientWithRow({
      campaign_future_cents: "100",
      learner_balance_cents: "25",
      pending_refund_atomic: "12345",
    }))

    expect(liability).toEqual({
      campaignFutureCents: 100n,
      learnerBalanceCents: 25n,
      pendingRefundAtomic: 12_345n,
      totalAtomic: 1_262_345n,
    })
  })

  test("alerts with the exact shortfall while reward feature flags are dark", async () => {
    const warn = mock(async (..._args: Parameters<typeof captureScheduledWarning>) => true)
    const summary = await monitorRewardCampaignTreasurySolvency({
      env: {
        ...env,
        REWARDS_CAMPAIGNS_ENABLED: "false",
        REWARDS_ACCRUAL_ENABLED: "false",
        REWARDS_PAYOUTS_ENABLED: "false",
      } as Env,
      client: clientWithRow({
        campaign_future_cents: "100",
        learner_balance_cents: "0",
        pending_refund_atomic: "0",
      }),
      readBalance: async () => 700_000n,
      warn,
    })

    expect(summary).toMatchObject({ configured: true, balanceAtomic: 700_000n, solvent: false })
    expect(summary.liability?.totalAtomic).toBe(1_000_000n)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[3]).toMatchObject({
      balance_usdc: "0.7",
      liability_usdc: "1.0",
      shortfall_usdc: "0.3",
      campaign_future_cents: "100",
    })
  })

  test("does not alert when treasury balance covers liabilities", async () => {
    const warn = mock(async (..._args: Parameters<typeof captureScheduledWarning>) => true)
    const summary = await monitorRewardCampaignTreasurySolvency({
      env,
      client: clientWithRow({
        campaign_future_cents: "100",
        learner_balance_cents: "25",
        pending_refund_atomic: "0",
      }),
      readBalance: async () => 2_000_000n,
      warn,
    })

    expect(summary.solvent).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })
})
