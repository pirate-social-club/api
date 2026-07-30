import { describe, expect, test } from "bun:test"
import { telegramCadenceOutcome } from "./telegram-cadence-outcome"

describe("telegramCadenceOutcome", () => {
  test("keeps delivery at the latency boundary green", () => {
    expect(telegramCadenceOutcome({
      delivered: true,
      elapsedMs: 15 * 60_000,
      latencySloMs: 15 * 60_000,
    })).toBe("within_slo")
  })

  test("distinguishes late delivery from failed liveness", () => {
    expect(telegramCadenceOutcome({
      delivered: true,
      elapsedMs: 15 * 60_000 + 1,
      latencySloMs: 15 * 60_000,
    })).toBe("latency_breach")
    expect(telegramCadenceOutcome({
      delivered: false,
      elapsedMs: 20 * 60_000,
      latencySloMs: 15 * 60_000,
    })).toBe("liveness_failure")
  })
})
