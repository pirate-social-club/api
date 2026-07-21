import { describe, expect, test } from "bun:test"

import { planRewardPayoutAllocations } from "./reward-cashout-service"

describe("planRewardPayoutAllocations", () => {
  test("allocates oldest credits deterministically and preserves campaign attribution", () => {
    expect(planRewardPayoutAllocations([
      { rewardEventId: "rew_legacy", rewardCampaignId: null, availableCents: 40 },
      { rewardEventId: "rew_campaign_a", rewardCampaignId: "rcp_a", availableCents: 100 },
      { rewardEventId: "rew_campaign_b", rewardCampaignId: "rcp_b", availableCents: 100 },
    ], 180)).toEqual([
      { rewardEventId: "rew_legacy", rewardCampaignId: null, amountCents: 40 },
      { rewardEventId: "rew_campaign_a", rewardCampaignId: "rcp_a", amountCents: 100 },
      { rewardEventId: "rew_campaign_b", rewardCampaignId: "rcp_b", amountCents: 40 },
    ])
  })

  test("refuses an allocation plan that cannot cover the reserved cashout", () => {
    expect(() => planRewardPayoutAllocations([
      { rewardEventId: "rew_campaign", rewardCampaignId: "rcp", availableCents: 99 },
    ], 100)).toThrow("Rewards cashout allocation does not match the available balance")
  })
})
