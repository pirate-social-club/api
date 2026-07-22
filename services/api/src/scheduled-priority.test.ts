import { describe, expect, test } from "bun:test"
import { SCHEDULED_MINIMUM_PRIORITY_STARTS, scheduledPriorityJobNames } from "./index"

describe("scheduled priority ordering", () => {
  // The drain is the retry engine for every community job. Outside the protected
  // prefix it gets deadline-trimmed off ticks, which is what left song posts on
  // "Preparing song features" for tens of minutes after a failed first attempt.
  test.each([
    ["d1 on, hns off", true, false],
    ["d1 off, hns off", false, false],
    ["d1 on, hns on", true, true],
  ])("keeps process_community_jobs inside the protected prefix (%s)", (_label, d1, hns) => {
    const index = scheduledPriorityJobNames(d1, hns).indexOf("process_community_jobs")
    expect(index).toBeGreaterThanOrEqual(0)
    expect(index).toBeLessThan(SCHEDULED_MINIMUM_PRIORITY_STARTS)
  })

  test("protects every settlement/money-movement job alongside the drain", () => {
    const protectedNames = scheduledPriorityJobNames(true, true).slice(0, SCHEDULED_MINIMUM_PRIORITY_STARTS)
    expect(protectedNames).toEqual([
      "reconcile_reward_payouts",
      "reconcile_royalty_claims",
      "reconcile_booking_settlements",
      "reconcile_purchase_settlements",
      "reconcile_royalty_allocation_verifications",
      "reconcile_reward_campaigns",
      "reconcile_reward_funding_refunds",
      "process_community_jobs",
    ])
  })

  test("keeps D1 provisioning ahead of the latency-tolerant reward monitor", () => {
    expect(scheduledPriorityJobNames(true, false)).toEqual([
      "reconcile_reward_payouts",
      "reconcile_royalty_claims",
      "reconcile_booking_settlements",
      "reconcile_purchase_settlements",
      "reconcile_royalty_allocation_verifications",
      "reconcile_reward_campaigns",
      "reconcile_reward_funding_refunds",
      "process_community_jobs",
      "monitor_reward_campaign_treasury_solvency",
      "reconcile_d1_provisioning",
      "monitor_reward_campaigns",
    ])
  })

  test("keeps the reward monitor in the priority set when D1 is unavailable", () => {
    expect(scheduledPriorityJobNames(false, false)).toEqual([
      "reconcile_reward_payouts",
      "reconcile_royalty_claims",
      "reconcile_booking_settlements",
      "reconcile_purchase_settlements",
      "reconcile_royalty_allocation_verifications",
      "reconcile_reward_campaigns",
      "reconcile_reward_funding_refunds",
      "process_community_jobs",
      "monitor_reward_campaign_treasury_solvency",
      "monitor_reward_campaigns",
    ])
  })

  test("schedules enabled HNS revalidation after D1 and before the reward monitor", () => {
    expect(scheduledPriorityJobNames(true, true)).toEqual([
      "reconcile_reward_payouts",
      "reconcile_royalty_claims",
      "reconcile_booking_settlements",
      "reconcile_purchase_settlements",
      "reconcile_royalty_allocation_verifications",
      "reconcile_reward_campaigns",
      "reconcile_reward_funding_refunds",
      "process_community_jobs",
      "monitor_reward_campaign_treasury_solvency",
      "reconcile_d1_provisioning",
      "revalidate_hns_namespaces",
      "monitor_reward_campaigns",
    ])
  })
})
