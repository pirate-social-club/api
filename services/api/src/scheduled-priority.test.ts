import { describe, expect, test } from "bun:test"
import { scheduledPriorityJobNames } from "./index"

describe("scheduled priority ordering", () => {
  test("keeps D1 provisioning ahead of the latency-tolerant reward monitor", () => {
    expect(scheduledPriorityJobNames(true, false)).toEqual([
      "reconcile_booking_settlements",
      "reconcile_royalty_allocation_verifications",
      "process_community_jobs",
      "reconcile_d1_provisioning",
      "monitor_reward_campaigns",
    ])
  })

  test("keeps the reward monitor in the priority set when D1 is unavailable", () => {
    expect(scheduledPriorityJobNames(false, false)).toEqual([
      "reconcile_booking_settlements",
      "reconcile_royalty_allocation_verifications",
      "process_community_jobs",
      "monitor_reward_campaigns",
    ])
  })

  test("schedules enabled HNS revalidation after D1 and before the reward monitor", () => {
    expect(scheduledPriorityJobNames(true, true)).toEqual([
      "reconcile_booking_settlements",
      "reconcile_royalty_allocation_verifications",
      "process_community_jobs",
      "reconcile_d1_provisioning",
      "revalidate_hns_namespaces",
      "monitor_reward_campaigns",
    ])
  })
})
