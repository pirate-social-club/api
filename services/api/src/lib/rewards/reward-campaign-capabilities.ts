import type { Env } from "../../env"
import { resolveRewardCampaignConfig } from "./reward-campaign-config"

export type RewardCampaignCapabilities = {
  enabled: boolean
  min_budget_cents: number
  max_budget_cents: number
  max_reward_cents: number
  min_duration_seconds: number
  max_duration_seconds: number
  default_duration_seconds: number
  eligible_activities: Array<"study" | "karaoke" | "either">
  chain_id: number
  token_address: string
}

const ELIGIBLE_ACTIVITIES: RewardCampaignCapabilities["eligible_activities"] = ["study", "karaoke", "either"]

/**
 * The pilot runs campaigns for a fixed 30 days. Clamping it into the configured
 * guardrails means a client can never be handed a duration the create route
 * would reject, even if the duration bounds are reconfigured.
 */
const PILOT_DURATION_SECONDS = 30 * 24 * 60 * 60

const DISABLED: RewardCampaignCapabilities = {
  enabled: false,
  min_budget_cents: 0,
  max_budget_cents: 0,
  max_reward_cents: 0,
  min_duration_seconds: 0,
  max_duration_seconds: 0,
  default_duration_seconds: 0,
  eligible_activities: [],
  chain_id: 0,
  token_address: "",
}

export function getRewardCampaignCapabilities(env: Env): RewardCampaignCapabilities {
  let config: ReturnType<typeof resolveRewardCampaignConfig>
  try {
    config = resolveRewardCampaignConfig(env)
  } catch {
    // Misconfiguration must not turn a capability probe into a 5xx. A client that
    // cannot read capabilities hides the entry point, which is the safe outcome.
    return DISABLED
  }
  if (!config.enabled) return DISABLED

  return {
    enabled: true,
    min_budget_cents: config.minBudgetCents,
    max_budget_cents: config.maxBudgetCents,
    max_reward_cents: config.maxRewardCents,
    min_duration_seconds: config.minDurationSeconds,
    max_duration_seconds: config.maxDurationSeconds,
    default_duration_seconds: Math.min(
      Math.max(PILOT_DURATION_SECONDS, config.minDurationSeconds),
      config.maxDurationSeconds,
    ),
    eligible_activities: ELIGIBLE_ACTIVITIES,
    chain_id: config.chainId,
    token_address: config.tokenAddress,
    // Deliberately omits rpcUrl (may carry a provider credential) and
    // treasuryAddress (the scoped funding quote supplies it).
  }
}
