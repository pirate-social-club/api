import { describe, expect, test } from "bun:test"

import {
  FLAT_REWARD_IDENTITY_PROVIDERS,
  isRewardIdentityProviderAllowedForCampaign,
  NATIONALITY_TIER_REWARD_IDENTITY_PROVIDERS,
} from "./reward-campaign-provider-policy"

describe("reward campaign provider policy", () => {
  test("keeps provider choices aligned with each campaign shape", () => {
    expect(FLAT_REWARD_IDENTITY_PROVIDERS).toEqual(["self", "zkpassport", "very"])
    expect(NATIONALITY_TIER_REWARD_IDENTITY_PROVIDERS).toEqual(["self", "zkpassport"])

    expect(isRewardIdentityProviderAllowedForCampaign("self", false)).toBe(true)
    expect(isRewardIdentityProviderAllowedForCampaign("zkpassport", false)).toBe(true)
    expect(isRewardIdentityProviderAllowedForCampaign("very", false)).toBe(true)
    expect(isRewardIdentityProviderAllowedForCampaign("self", true)).toBe(true)
    expect(isRewardIdentityProviderAllowedForCampaign("zkpassport", true)).toBe(true)
    expect(isRewardIdentityProviderAllowedForCampaign("very", true)).toBe(false)
  })
})
