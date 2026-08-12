import type { Client, QueryResultRow } from "../sql-client"
import { rowValue } from "../sql-row"

export type RewardLifecycleSnapshot = {
  campaign: {
    status: string
    fundedCents: number
    reservedCents: number
    creditedCents: number
    paidCents: number
  }
  qualificationEvents: number
  reservations: number
  rewardEvents: number
  pendingQualifications: number
  payoutEffects: number
}

function numberValue(row: QueryResultRow, field: string): number {
  const value = Number(rowValue(row, field))
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`lifecycle_snapshot_invalid_${field}`)
  return value
}

function requiredStatus(row: QueryResultRow): string {
  const value = rowValue(row, "status")
  if (typeof value !== "string" || value.length === 0) throw new Error("lifecycle_snapshot_missing_status")
  return value
}

export async function readRewardLifecycleSnapshot(input: {
  client: Pick<Client, "execute">
  campaignId: string
  userId: string
}): Promise<RewardLifecycleSnapshot> {
  const result = await input.client.execute({
    sql: `
      SELECT c.status, c.funded_cents, c.reserved_cents, c.credited_cents, c.paid_cents,
        (
          SELECT COUNT(*)
          FROM reward_qualification_events q
          WHERE q.user_id = ?2
            AND q.community_id = c.community_id
            AND q.post_id = c.post_id
            AND q.song_artifact_bundle_id = c.song_artifact_bundle_id
            AND q.qualified_at >= c.starts_at
            AND q.qualified_at <= c.ends_at
        ) AS qualification_events,
        (SELECT COUNT(*) FROM reward_campaign_reservations r
          WHERE r.reward_campaign_id = c.reward_campaign_id AND r.user_id = ?2) AS reservations,
        (SELECT COUNT(*) FROM reward_events e
          WHERE e.reward_campaign_id = c.reward_campaign_id AND e.user_id = ?2) AS reward_events,
        (SELECT COUNT(*) FROM reward_pending_qualifications p
          WHERE p.reward_campaign_id = c.reward_campaign_id AND p.user_id = ?2) AS pending_qualifications,
        (SELECT COUNT(*) FROM reward_payout_effects p
          WHERE p.user_id = ?2) AS payout_effects
      FROM reward_campaigns c
      WHERE c.reward_campaign_id = ?1
      LIMIT 1
    `,
    args: [input.campaignId, input.userId],
  })
  const row = result.rows[0]
  if (!row) throw new Error("lifecycle_snapshot_campaign_not_found")
  return {
    campaign: {
      status: requiredStatus(row),
      fundedCents: numberValue(row, "funded_cents"),
      reservedCents: numberValue(row, "reserved_cents"),
      creditedCents: numberValue(row, "credited_cents"),
      paidCents: numberValue(row, "paid_cents"),
    },
    qualificationEvents: numberValue(row, "qualification_events"),
    reservations: numberValue(row, "reservations"),
    rewardEvents: numberValue(row, "reward_events"),
    pendingQualifications: numberValue(row, "pending_qualifications"),
    payoutEffects: numberValue(row, "payout_effects"),
  }
}

export function assertRewardLifecycleReplayStable(
  first: RewardLifecycleSnapshot,
  replay: RewardLifecycleSnapshot,
): void {
  if (JSON.stringify(first) !== JSON.stringify(replay)) {
    throw new Error(`lifecycle_replay_changed_state: first=${JSON.stringify(first)} replay=${JSON.stringify(replay)}`)
  }
}

export function assertRewardLifecycleCreditReady(snapshot: RewardLifecycleSnapshot): void {
  if (snapshot.campaign.fundedCents <= 0) throw new Error("lifecycle_campaign_is_not_funded")
  if (snapshot.qualificationEvents <= 0) throw new Error("lifecycle_qualification_was_not_ingested")
  if (snapshot.rewardEvents <= 0 || snapshot.campaign.creditedCents <= 0) {
    throw new Error("lifecycle_qualification_was_not_credited")
  }
}
