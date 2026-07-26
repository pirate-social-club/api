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
    execute: async (statement: string | { sql: string }) => {
      const sql = typeof statement === "string" ? statement : statement.sql
      return sql.includes("INSERT INTO reward_solvency_observations")
        || sql.includes("INSERT INTO reward_vault_capacity_observations")
        ? { rows: [], columns: [] }
        : { rows: [row], columns: [] }
    },
  } as unknown as Client
}

const env = {
  REWARDS_CAMPAIGN_CHAIN_ID: "84532",
  REWARDS_CAMPAIGN_USDC_TOKEN_ADDRESS: "0x1000000000000000000000000000000000000001",
  REWARDS_CAMPAIGN_TREASURY_ADDRESS: "0x2000000000000000000000000000000000000002",
  REWARDS_CAMPAIGN_RPC_URL: "https://base-sepolia.example.test",
} as Env

describe("reward campaign treasury solvency monitor", () => {
  test("combines unconsumed contribution lots, credited-unpaid balances, and exact pending refunds", async () => {
    const liability = await readRewardCampaignLiability(clientWithRow({
      contribution_liability_cents: "100",
      credited_unpaid_liability_cents: "25",
      pending_refund_atomic: "12345",
    }))

    expect(liability).toEqual({
      contributionLiabilityCents: 100n,
      creditedUnpaidLiabilityCents: 25n,
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
        contribution_liability_cents: "100",
        credited_unpaid_liability_cents: "0",
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
      contribution_liability_cents: "100",
    })
  })

  test("does not alert when treasury balance covers liabilities", async () => {
    const warn = mock(async (..._args: Parameters<typeof captureScheduledWarning>) => true)
    const summary = await monitorRewardCampaignTreasurySolvency({
      env,
      client: clientWithRow({
        contribution_liability_cents: "100",
        credited_unpaid_liability_cents: "25",
        pending_refund_atomic: "0",
      }),
      readBalance: async () => 2_000_000n,
      warn,
    })

    expect(summary.solvent).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  test("alerts on a depleted Lit signer and recent nonce contention", async () => {
    const warn = mock(async (..._args: Parameters<typeof captureScheduledWarning>) => true)
    const client = {
      execute: async (statement: string | { sql: string }) => {
        const sql = typeof statement === "string" ? statement : statement.sql
        if (sql.includes("nonce_anomalies")) return { rows: [{ nonce_anomalies: "2" }] }
        if (sql.includes("INSERT INTO reward_solvency_observations")) return { rows: [] }
        return {
          rows: [{
            contribution_liability_cents: "100",
            credited_unpaid_liability_cents: "0",
            pending_refund_atomic: "0",
          }],
        }
      },
    } as unknown as Client
    const summary = await monitorRewardCampaignTreasurySolvency({
      env: {
        ...env,
        PIRATE_REWARDS_SETTLEMENT_BACKEND: "lit_vault",
        PIRATE_REWARDS_SETTLEMENT_OPERATOR_ADDRESS: "0x3000000000000000000000000000000000000003",
        REWARDS_LIT_SIGNER_MIN_ETH_WEI: "100",
      } as Env,
      client,
      readBalance: async () => 2_000_000n,
      readSignerBalance: async () => 50n,
      readCapacity: async () => ({
        policyVersion: 3n,
        epochDurationSeconds: 86_400n,
        currentEpoch: 20_000n,
        payoutEpochCapAtomic: 10_000_000n,
        payoutSpentAtomic: 2_000_000n,
        refundEpochCapAtomic: 5_000_000n,
        refundSpentAtomic: 1_000_000n,
        observedBlockNumber: 12_345,
        observedBlockHash: `0x${"ab".repeat(32)}`,
      }),
      warn,
    })

    expect(summary).toMatchObject({
      signerBalanceWei: 50n,
      nonceAnomalies: 2,
      vaultCapacity: {
        currentEpoch: 20_000n,
        payoutSpentAtomic: 2_000_000n,
      },
    })
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls.map((call) => call[2])).toEqual([
      "reward_campaign_treasury_solvency:signer_eth",
      "reward_campaign_treasury_solvency:nonce_contention",
    ])
  })
})
