import type { Env } from "../../env"
import { codedConflictError } from "../errors"
import { rowValue, stringOrNull } from "../sql-row"
import type { Client } from "../sql-client"
import {
  resolveRewardIdentityProvider,
  type RewardIdentityProvider,
} from "../verification/unique-human-eligibility"

export const REWARD_IDENTITY_PROVIDER_INCOMPATIBLE = "reward_identity_provider_incompatible"

export function assertRewardProviderCompatibleWithCashout(input: {
  env: Env
  campaignProvider: string
}): RewardIdentityProvider {
  const cashoutProvider = resolveRewardIdentityProvider(input.env.REWARDS_IDENTITY_PROVIDER)
  if (!cashoutProvider || input.campaignProvider !== cashoutProvider) {
    throw codedConflictError(
      REWARD_IDENTITY_PROVIDER_INCOMPATIBLE,
      "Reward pool identity provider is not compatible with the current cashout provider",
      {
        campaign_provider: input.campaignProvider,
        cashout_provider: cashoutProvider,
      },
    )
  }
  return cashoutProvider
}

/**
 * Environment changes bypass campaign/funding write guards. Refuse to run the
 * accrual reconciler while an open campaign or unpaid credited balance is pinned
 * to a provider that the current cashout path cannot honor.
 */
export async function assertOpenRewardCampaignProvidersCompatible(input: {
  env: Env
  client: Pick<Client, "execute">
}): Promise<void> {
  const cashoutProvider = resolveRewardIdentityProvider(input.env.REWARDS_IDENTITY_PROVIDER)
  const providerMismatchPredicate = cashoutProvider
    ? "AND reward_identity_provider <> ?1"
    : ""
  const result = await input.client.execute({
    sql: `
      SELECT reward_campaign_id, reward_identity_provider, status,
             credited_cents, paid_cents
      FROM reward_campaigns
      WHERE (
          status IN (
            'draft', 'funding_quoted', 'funding_confirming', 'scheduled',
            'active', 'paused', 'operational_hold'
          )
          OR credited_cents > paid_cents
        )
        ${providerMismatchPredicate}
      ORDER BY created_at ASC, reward_campaign_id ASC
      LIMIT 20
    `,
    args: cashoutProvider ? [cashoutProvider] : [],
  })
  if (result.rows.length === 0) return

  const campaigns = result.rows.map((row) => ({
    id: stringOrNull(rowValue(row, "reward_campaign_id")),
    provider: stringOrNull(rowValue(row, "reward_identity_provider")),
    status: stringOrNull(rowValue(row, "status")),
    unpaid_cents: Number(rowValue(row, "credited_cents") ?? 0)
      - Number(rowValue(row, "paid_cents") ?? 0),
  }))
  console.error("[reward-campaigns] cashout provider compatibility invariant failed", {
    code: REWARD_IDENTITY_PROVIDER_INCOMPATIBLE,
    cashout_provider: cashoutProvider,
    campaigns,
  })
  throw new Error(`${REWARD_IDENTITY_PROVIDER_INCOMPATIBLE}: open reward campaigns are incompatible with cashout`)
}
