import { describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import {
  isRewardRehearsalScenario,
  rewardRehearsalRequest,
} from "./reward-rehearsal"

describe("reward rehearsal fixtures", () => {
  test("accepts only the four scenario enums", () => {
    expect(["replay", "over_limit", "deadline_expired", "stale_policy"]
      .every(isRewardRehearsalScenario)).toBe(true)
    expect(isRewardRehearsalScenario("amount=1")).toBe(false)
  })

  test("derives immutable one-field fixtures server-side", () => {
    const env = { ENVIRONMENT: "staging" } as Env
    const replay = rewardRehearsalRequest(env, "replay")
    const deadline = rewardRehearsalRequest(env, "deadline_expired")
    const overLimit = rewardRehearsalRequest(env, "over_limit")
    const stale = rewardRehearsalRequest(env, "stale_policy")

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
  })

  test("fails closed outside staging", () => {
    expect(() => rewardRehearsalRequest({ ENVIRONMENT: "production" } as Env, "replay"))
      .toThrow("staging-only")
  })
})
