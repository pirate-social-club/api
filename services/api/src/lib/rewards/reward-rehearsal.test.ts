import { describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import {
  isRewardRehearsalScenario,
  rewardEpochCapCashoutFixture,
  rewardRehearsalRequest,
} from "./reward-rehearsal"

describe("reward rehearsal fixtures", () => {
  test("accepts only the fixed scenario enums", () => {
    expect([
      "replay",
      "over_limit",
      "deadline_expired",
      "stale_policy",
      "refund_while_payouts_paused",
      "epoch_cap_fill_1",
      "epoch_cap_fill_2",
      "epoch_cap_defer",
    ]
      .every(isRewardRehearsalScenario)).toBe(true)
    expect(isRewardRehearsalScenario("amount=1")).toBe(false)
  })

  test("derives immutable one-field fixtures server-side", () => {
    const env = { ENVIRONMENT: "staging" } as Env
    const replay = rewardRehearsalRequest(env, "replay")
    const deadline = rewardRehearsalRequest(env, "deadline_expired")
    const overLimit = rewardRehearsalRequest(env, "over_limit")
    const stale = rewardRehearsalRequest(env, "stale_policy")
    const refund = rewardRehearsalRequest(env, "refund_while_payouts_paused")

    expect(replay.payoutEffectId).toBe("rpe_4d49a8ee731d4fa2b6eab990a013c757")
    expect(overLimit.amountCents).toBe(60)
    expect(overLimit.idempotencyKey).toBe("rehearsal:scenario5:20260729:v2")
    expect([replay, deadline, stale].map((fixture) => fixture.amountCents)).toEqual([50, 50, 50])
    expect(new Set([deadline.payoutEffectId, overLimit.payoutEffectId, stale.payoutEffectId]).size).toBe(3)
    expect([replay, deadline, overLimit, stale].every((fixture) =>
      fixture.recipientAddress === replay.recipientAddress
      && fixture.userId === replay.userId
      && fixture.effectKind === "reward_cashout"
    )).toBe(true)
    expect(refund).toEqual({
      operatorKind: "rewards",
      fundingEffectId: "rcf_13000000000000000000000020260729",
      idempotencyKey: "rcf_13000000000000000000000020260729",
      effectKind: "reward_funding_refund",
      amountAtomic: "500000",
      recipientAddress: replay.recipientAddress,
      rehearsalScenario: "refund_while_payouts_paused",
    })
  })

  test("derives three distinct fixed 50-cent epoch-cap cashouts", () => {
    const fixtures = [
      rewardEpochCapCashoutFixture("epoch_cap_fill_1"),
      rewardEpochCapCashoutFixture("epoch_cap_fill_2"),
      rewardEpochCapCashoutFixture("epoch_cap_defer"),
    ]
    expect(fixtures.map((fixture) => fixture.amountCents)).toEqual([50, 50, 50])
    expect(new Set(fixtures.map((fixture) => fixture.idempotencyKey)).size).toBe(3)
    expect(new Set(fixtures.map((fixture) => fixture.userId)).size).toBe(1)
    expect(fixtures.map((fixture) => fixture.idempotencyKey)).toEqual([
      "rehearsal:scenario7:fill1:20260729",
      "rehearsal:scenario7:fill2:20260729",
      "rehearsal:scenario7:defer:20260729",
    ])
  })

  test("fails closed outside staging", () => {
    expect(() => rewardRehearsalRequest({ ENVIRONMENT: "production" } as Env, "replay"))
      .toThrow("staging-only")
  })
})
