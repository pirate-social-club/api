import {
  SUPPORTED_REWARD_IDENTITY_PROVIDERS,
  type RewardIdentityProvider,
} from "../verification/unique-human-eligibility"

export const FLAT_REWARD_IDENTITY_PROVIDERS = SUPPORTED_REWARD_IDENTITY_PROVIDERS

export const NATIONALITY_TIER_REWARD_IDENTITY_PROVIDERS = SUPPORTED_REWARD_IDENTITY_PROVIDERS.filter(
  (provider): provider is Exclude<RewardIdentityProvider, "very"> => provider !== "very",
)

export function isRewardCampaignIdentityProvider(value: unknown): value is RewardIdentityProvider {
  return typeof value === "string"
    && (SUPPORTED_REWARD_IDENTITY_PROVIDERS as readonly string[]).includes(value)
}

export function isNationalityTierRewardIdentityProvider(
  provider: unknown,
): provider is Exclude<RewardIdentityProvider, "very"> {
  return isRewardCampaignIdentityProvider(provider)
    && (NATIONALITY_TIER_REWARD_IDENTITY_PROVIDERS as readonly RewardIdentityProvider[]).includes(provider)
}

export function isRewardIdentityProviderAllowedForCampaign(
  provider: unknown,
  tiered: boolean,
): provider is RewardIdentityProvider {
  return tiered
    ? isNationalityTierRewardIdentityProvider(provider)
    : isRewardCampaignIdentityProvider(provider)
}
