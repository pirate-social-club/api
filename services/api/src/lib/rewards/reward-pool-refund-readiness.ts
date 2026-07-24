import type { Client } from "../sql-client"
import { rowValue } from "../sql-row"

const USDC_ATOMS_PER_CENT = 10_000n

export type RewardPoolRefundPolicyReadiness = {
  largest_outstanding_lot_remainder_cents: number
  largest_outstanding_lot_remainder_atomic: string
  proposed_max_refund_atomic: string | null
  proposal_safe: boolean | null
}

export async function getRewardPoolRefundPolicyReadiness(input: {
  client: Client
  proposedMaxRefundAtomic?: bigint
}): Promise<RewardPoolRefundPolicyReadiness> {
  const result = await input.client.execute(`
    SELECT COALESCE(MAX(remaining_cents), 0) AS largest_remainder_cents
    FROM (
      SELECT
        f.expected_amount_cents - COALESCE(SUM(a.amount_cents), 0) AS remaining_cents
      FROM reward_campaign_funding_effects f
      LEFT JOIN reward_campaign_reservation_funding_allocations a
        ON a.reward_campaign_funding_effect_id = f.reward_campaign_funding_effect_id
      WHERE f.status = 'confirmed'
      GROUP BY f.reward_campaign_funding_effect_id, f.expected_amount_cents
    ) contribution_lot_remainders
  `)
  const cents = Number(rowValue(result.rows[0], "largest_remainder_cents") ?? 0)
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error("largest reward contribution lot remainder is invalid")
  }
  const atomic = BigInt(cents) * USDC_ATOMS_PER_CENT
  const proposed = input.proposedMaxRefundAtomic
  return {
    largest_outstanding_lot_remainder_cents: cents,
    largest_outstanding_lot_remainder_atomic: atomic.toString(),
    proposed_max_refund_atomic: proposed?.toString() ?? null,
    proposal_safe: proposed === undefined ? null : proposed >= atomic,
  }
}
