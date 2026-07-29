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

  test("consumes unresolved legacy confirmed payouts before allocating a new cashout", () => {
    expect(planRewardPayoutAllocations([
      { rewardEventId: "rew_old_a", rewardCampaignId: "rcp_old_a", availableCents: 100 },
      { rewardEventId: "rew_old_b", rewardCampaignId: "rcp_old_b", availableCents: 100 },
      { rewardEventId: "rew_current", rewardCampaignId: "rcp_current", availableCents: 50 },
    ], 50, 200)).toEqual([
      { rewardEventId: "rew_current", rewardCampaignId: "rcp_current", amountCents: 50 },
    ])
  })

  test("fails closed when the unresolved legacy paid amount exceeds available events", () => {
    expect(() => planRewardPayoutAllocations([
      { rewardEventId: "rew_old", rewardCampaignId: "rcp_old", availableCents: 100 },
    ], 50, 101)).toThrow("Rewards cashout allocation does not match the available balance")
  })
})
