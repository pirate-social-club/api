import { describe, expect, test } from "bun:test"
import { scheduledPriorityJobNames } from "./index"

describe("scheduled priority ordering", () => {
  test("keeps D1 provisioning ahead of the latency-tolerant reward monitor", () => {
    expect(scheduledPriorityJobNames(true)).toEqual([
      "reconcile_booking_settlements",
      "reconcile_royalty_allocation_verifications",
      "reconcile_d1_provisioning",
      "monitor_reward_campaigns",
    ])
  })

  test("keeps the reward monitor in the priority set when D1 is unavailable", () => {
    expect(scheduledPriorityJobNames(false)).toEqual([
      "reconcile_booking_settlements",
      "reconcile_royalty_allocation_verifications",
      "monitor_reward_campaigns",
    ])
  })
})
