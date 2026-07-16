import type { Client } from "../sql-client"
import { withTransaction } from "../transactions"

export type RewardCampaignLifecycleSummary = {
  activated_campaigns: number
  ended_campaigns: number
}

export async function advanceRewardCampaignLifecycle(input: {
  client: Client
  now: string
}): Promise<RewardCampaignLifecycleSummary> {
  const nowMs = Date.parse(input.now)
  if (!Number.isFinite(nowMs)) throw new Error("Reward campaign lifecycle timestamp is invalid")

  return withTransaction(input.client, "write", async (tx) => {
    const ended = await tx.execute({
      sql: `
        UPDATE reward_campaigns
        SET status = 'ended', ended_at = COALESCE(ended_at, ?1), updated_at = ?1
        WHERE status IN ('scheduled', 'active', 'paused')
          AND ends_at <= ?1
        RETURNING reward_campaign_id
      `,
      args: [input.now],
    })
    const activated = await tx.execute({
      sql: `
        UPDATE reward_campaigns
        SET status = 'active', activated_at = COALESCE(activated_at, ?1), updated_at = ?1
        WHERE status = 'scheduled'
          AND starts_at <= ?1
          AND ends_at > ?1
        RETURNING reward_campaign_id
      `,
      args: [input.now],
    })
    return {
      activated_campaigns: activated.rows.length,
      ended_campaigns: ended.rows.length,
    }
  })
}
