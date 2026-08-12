import type { RewardCampaignFundingQuote } from "@pirate/api-contracts"

import type { Env } from "../../env"
import { rowValue, requiredString } from "../sql-row"
import type { Client } from "../sql-client"
import { resolveRewardCampaignConfig } from "./reward-campaign-config"
import { confirmRewardCampaignFunding } from "./reward-campaign-service"

type ConfirmFunding = (input: {
  env: Env
  client: Client
  userId: string
  campaignId: string
  fundingId: string
  txHash: string
  now?: string
}) => Promise<RewardCampaignFundingQuote>

export type RewardFundingConfirmationReconcileSummary = {
  enabled: boolean
  scanned: number
  confirmed: number
  pending: number
  terminal: number
  errors: number
}

function emptySummary(enabled: boolean): RewardFundingConfirmationReconcileSummary {
  return {
    enabled,
    scanned: 0,
    confirmed: 0,
    pending: 0,
    terminal: 0,
    errors: 0,
  }
}

/**
 * Advances submitted funding independently of the originating browser.
 *
 * The first client confirmation persists the transaction hash and moves the
 * effect to `confirming`. From then on this scheduled reconciler reuses the
 * same receipt verifier and idempotent state transition until the safe head
 * reaches the receipt or the verifier reaches a terminal decision.
 */
export async function reconcileConfirmingRewardCampaignFunding(input: {
  env: Env
  client: Client
  limit?: number
  now?: string
  confirm?: ConfirmFunding
}): Promise<RewardFundingConfirmationReconcileSummary> {
  const config = resolveRewardCampaignConfig(input.env)
  if (!config.enabled) return emptySummary(false)

  const limit = Math.max(1, Math.min(500, Math.trunc(input.limit ?? 100)))
  const candidates = await input.client.execute({
    sql: `
      SELECT reward_campaign_funding_effect_id, reward_campaign_id,
        funder_user_id, tx_hash
      FROM reward_campaign_funding_effects
      WHERE status = 'confirming' AND tx_hash IS NOT NULL
      ORDER BY updated_at, reward_campaign_funding_effect_id
      LIMIT ?1
    `,
    args: [limit],
  })
  const summary = emptySummary(true)
  const confirm = input.confirm ?? confirmRewardCampaignFunding

  for (const row of candidates.rows) {
    summary.scanned += 1
    try {
      const funding = await confirm({
        env: input.env,
        client: input.client,
        userId: requiredString(row, "funder_user_id"),
        campaignId: requiredString(row, "reward_campaign_id"),
        fundingId: requiredString(row, "reward_campaign_funding_effect_id"),
        txHash: requiredString(row, "tx_hash"),
        now: input.now,
      })
      if (funding.status === "confirmed") summary.confirmed += 1
      else if (funding.status === "confirming") summary.pending += 1
      else summary.terminal += 1
    } catch (error) {
      summary.errors += 1
      console.error("[reward-campaigns] confirming funding reconciliation failed", {
        campaign_id: rowValue(row, "reward_campaign_id"),
        funding_id: rowValue(row, "reward_campaign_funding_effect_id"),
        error,
      })
    }
  }

  return summary
}
