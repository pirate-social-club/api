import type { Env } from "../../env"

export type RewardCampaignAlertOwnership = {
  owner: string
  destination: string
}

function hasConfiguredOpsAlertDeliverySink(env: Env): boolean {
  const emailReady = Boolean(
    env.OPS_ALERT_EMAIL
    && String(env.OPS_ALERT_EMAIL_TO ?? "").trim()
    && String(env.OPS_ALERT_EMAIL_FROM ?? "").trim(),
  )
  return emailReady || Boolean(String(env.OPS_ALERT_WEBHOOK_URL ?? "").trim())
}

export function rewardCampaignAlertOwnership(env: Env): RewardCampaignAlertOwnership | null {
  const owner = String(env.REWARDS_CAMPAIGN_ALERT_OWNER ?? "").trim()
  const destination = String(env.REWARDS_CAMPAIGN_ALERT_DESTINATION ?? "").trim()
  if (!owner || !destination || !hasConfiguredOpsAlertDeliverySink(env)) return null
  return { owner, destination }
}

export function requireRewardCampaignAlertOwnership(env: Env): RewardCampaignAlertOwnership {
  const ownership = rewardCampaignAlertOwnership(env)
  if (!ownership) throw new Error("reward_campaign_alert_delivery_not_configured")
  return ownership
}
