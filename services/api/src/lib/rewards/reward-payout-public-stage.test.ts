import { describe, expect, test } from "bun:test"

import { rewardPayoutPublicStage } from "./reward-payout-public-stage"

describe("rewardPayoutPublicStage", () => {
  test.each([
    ["submitted", null, "reserved"],
    ["submitted", "reserving", "reserved"],
    ["submitted", "prepared", "signed"],
    ["submitted", "broadcast", "broadcast"],
    ["submitted", "reconciliation_required", "needs_review"],
    ["submitted", "capacity_deferred", "needs_review"],
    ["submitted", "preparation_parked", "needs_review"],
    ["submitted", "confirmed", "needs_review"],
    ["confirmed", "broadcast", "confirmed"],
    ["failed", "failed_onchain", "failed"],
  ] as const)("maps %s / %s to %s", (status, coordinatorState, expected) => {
    expect(rewardPayoutPublicStage({ coordinatorState, status })).toBe(expected)
  })
})
