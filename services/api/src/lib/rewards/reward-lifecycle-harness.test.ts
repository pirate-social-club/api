import { describe, expect, test } from "bun:test"

import {
  assertRewardLifecycleCreditReady,
  assertRewardLifecycleReplayStable,
  type RewardLifecycleSnapshot,
} from "./reward-lifecycle-harness"

const snapshot: RewardLifecycleSnapshot = {
  campaign: {
    status: "active",
    fundedCents: 100,
    reservedCents: 0,
    creditedCents: 40,
    paidCents: 0,
  },
  qualificationEvents: 1,
  reservations: 1,
  rewardEvents: 1,
  pendingQualifications: 0,
  payoutEffects: 0,
}

describe("reward lifecycle rehearsal assertions", () => {
  test("accepts a replay that leaves the ledger unchanged", () => {
    expect(() => assertRewardLifecycleReplayStable(snapshot, { ...snapshot, campaign: { ...snapshot.campaign } })).not.toThrow()
  })

  test("rejects a replay that changes a money counter", () => {
    expect(() => assertRewardLifecycleReplayStable(snapshot, {
      ...snapshot,
      campaign: { ...snapshot.campaign, creditedCents: 80 },
    })).toThrow("lifecycle_replay_changed_state")
  })

  test("requires funding and an ingested qualification before credit/cashout", () => {
    expect(() => assertRewardLifecycleCreditReady(snapshot)).not.toThrow()
    expect(() => assertRewardLifecycleCreditReady({
      ...snapshot,
      qualificationEvents: 0,
    })).toThrow("lifecycle_qualification_was_not_ingested")
    expect(() => assertRewardLifecycleCreditReady({
      ...snapshot,
      rewardEvents: 0,
    })).toThrow("lifecycle_qualification_was_not_credited")
  })
})
