import { describe, expect, test } from "bun:test"
import {
  SCHEDULED_MINIMUM_PRIORITY_STARTS,
  scheduledMinimumPriorityStarts,
  scheduledPriorityJobNames,
} from "./index"

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
      "monitor_reward_campaign_treasury_solvency",
      "monitor_reward_campaigns",
      "process_community_jobs",
    ])
  })

  test("guarantees D1 reconciliation a start when the binding is configured", () => {
    const names = scheduledPriorityJobNames(true, false)
    const reconcilerIndex = names.indexOf("reconcile_d1_provisioning")
    expect(reconcilerIndex).toBeGreaterThanOrEqual(0)
    expect(reconcilerIndex).toBeLessThan(scheduledMinimumPriorityStarts(true))
    expect(scheduledMinimumPriorityStarts(true)).toBe(SCHEDULED_MINIMUM_PRIORITY_STARTS + 1)
    expect(scheduledMinimumPriorityStarts(false)).toBe(SCHEDULED_MINIMUM_PRIORITY_STARTS)
  })

  test("guarantees enabled root observation a start inside its freshness budget", () => {
    const names = scheduledPriorityJobNames(true, false, true)
    const observerIndex = names.indexOf("observe_hns_roots")
    expect(observerIndex).toBeGreaterThanOrEqual(0)
    expect(observerIndex).toBeLessThan(scheduledMinimumPriorityStarts(true, true))
    expect(scheduledMinimumPriorityStarts(true, true)).toBe(SCHEDULED_MINIMUM_PRIORITY_STARTS + 2)
    expect(scheduledMinimumPriorityStarts(false, true)).toBe(SCHEDULED_MINIMUM_PRIORITY_STARTS + 1)
  })

  test("keeps both reward watchdogs protected ahead of D1 work", () => {
    expect(scheduledPriorityJobNames(true, false)).toEqual([
      "reconcile_reward_payouts",
      "reconcile_royalty_claims",
      "reconcile_booking_settlements",
      "reconcile_purchase_settlements",
      "reconcile_royalty_allocation_verifications",
      "reconcile_reward_campaigns",
      "reconcile_reward_funding_refunds",
      "monitor_reward_campaign_treasury_solvency",
      "monitor_reward_campaigns",
      "process_community_jobs",
      "reconcile_d1_provisioning",
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
      "monitor_reward_campaign_treasury_solvency",
      "monitor_reward_campaigns",
      "process_community_jobs",
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
      "monitor_reward_campaign_treasury_solvency",
      "monitor_reward_campaigns",
      "process_community_jobs",
      "reconcile_d1_provisioning",
      "revalidate_hns_namespaces",
    ])
  })

  test("schedules root observation before latency-tolerant monitoring and revalidation", () => {
    expect(scheduledPriorityJobNames(true, true, true)).toEqual([
      "reconcile_reward_payouts",
      "reconcile_royalty_claims",
      "reconcile_booking_settlements",
      "reconcile_purchase_settlements",
      "reconcile_royalty_allocation_verifications",
      "reconcile_reward_campaigns",
      "reconcile_reward_funding_refunds",
      "monitor_reward_campaign_treasury_solvency",
      "monitor_reward_campaigns",
      "process_community_jobs",
      "reconcile_d1_provisioning",
      "observe_hns_roots",
      "revalidate_hns_namespaces",
    ])
  })
})
