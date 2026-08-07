import type { Client } from "../sql-client"
import { rowValue } from "../sql-row"

export const REWARD_QUALIFICATION_GRACE_MS = 7 * 86_400_000

export function rewardCampaignCandidateCutoff(now: string): string {
  const nowMs = Date.parse(now)
  if (!Number.isFinite(nowMs)) throw new TypeError("invalid reward reconciliation time")
  return new Date(nowMs - REWARD_QUALIFICATION_GRACE_MS).toISOString()
}

export async function listRewardCampaignCommunityIds(input: {
  client: Pick<Client, "execute">
  now: string
  postgres: boolean
}): Promise<string[]> {
  const cutoff = rewardCampaignCandidateCutoff(input.now)
  const cutoffExpression = input.postgres ? "CAST(?1 AS TIMESTAMPTZ)" : "CAST(?1 AS TEXT)"
  const result = await input.client.execute({
    sql: `
      SELECT DISTINCT community_id
      FROM reward_campaigns
      WHERE ends_at >= ${cutoffExpression}
      ORDER BY community_id ASC
    `,
    args: [cutoff],
  })
  return result.rows
    .map((row) => rowValue(row, "community_id"))
    .filter((communityId): communityId is string => typeof communityId === "string" && communityId.length > 0)
}
