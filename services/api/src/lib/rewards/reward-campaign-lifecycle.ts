import type { Client } from "../sql-client"
import { withTransaction } from "../transactions"

export type RewardCampaignLifecycleSummary = {
  activated_campaigns: number
  canceled_draft_campaigns: number
  ended_campaigns: number
}

export const UNFUNDED_DRAFT_POOL_TTL_SECONDS = 24 * 60 * 60

export async function advanceRewardCampaignLifecycle(input: {
  client: Client
  now: string
}): Promise<RewardCampaignLifecycleSummary> {
  const nowMs = Date.parse(input.now)
  if (!Number.isFinite(nowMs)) throw new Error("Reward campaign lifecycle timestamp is invalid")
  const draftCutoff = new Date(nowMs - UNFUNDED_DRAFT_POOL_TTL_SECONDS * 1000).toISOString()

  return withTransaction(input.client, "write", async (tx) => {
    const canceledDrafts = await tx.execute({
      sql: `
        UPDATE reward_campaigns
        SET status = 'canceled', canceled_at = CAST(?1 AS TEXT), updated_at = ?1
        WHERE status = 'draft'
          AND created_at <= ?2
          AND funded_cents = 0
          AND reserved_cents = 0
          AND credited_cents = 0
          AND paid_cents = 0
          AND refunded_cents = 0
          AND NOT EXISTS (
            SELECT 1
            FROM reward_campaign_funding_effects AS funding
            WHERE funding.reward_campaign_id = reward_campaigns.reward_campaign_id
          )
        RETURNING reward_campaign_id
      `,
      args: [input.now, draftCutoff],
    })
    const ended = await tx.execute({
      sql: `
        UPDATE reward_campaigns
        SET status = 'ended', ended_at = COALESCE(ended_at, CAST(?1 AS TEXT)), updated_at = ?1
        WHERE status IN ('scheduled', 'active', 'paused', 'exhausted')
          AND ends_at <= ?1
        RETURNING reward_campaign_id
      `,
      args: [input.now],
    })
    await tx.execute({
      sql: `
        DELETE FROM reward_song_pools
        WHERE reward_campaign_id IN (
          SELECT reward_campaign_id
          FROM reward_campaigns
          WHERE status IN ('ended', 'canceled')
        )
      `,
      args: [],
    })
    const activated = await tx.execute({
      sql: `
        UPDATE reward_campaigns
        SET status = 'active', activated_at = COALESCE(activated_at, CAST(?1 AS TEXT)), updated_at = ?1
        WHERE status = 'scheduled'
          AND starts_at <= ?1
          AND ends_at > ?1
        RETURNING reward_campaign_id
      `,
      args: [input.now],
    })
    return {
      activated_campaigns: activated.rows.length,
      canceled_draft_campaigns: canceledDrafts.rows.length,
      ended_campaigns: ended.rows.length,
    }
  })
}
