import { describe, expect, it } from "bun:test"

import {
  CAPACITY_RETRY_CONFIRMATION_ALLOWANCE_SECONDS,
  CAPACITY_RETRY_MAX_JITTER_SECONDS,
  RewardCapacityRetryError,
  crossCheckDeferredEpoch,
  deterministicRetryJitterSeconds,
  resolveCapacityRetryAtMs,
} from "./reward-vault-capacity-retry"

const EFFECT_ID = "rpe_0123456789abcdef0123456789abcdef"
const HOUR = 3600n
const DAY = 86_400n

describe("deterministicRetryJitterSeconds", () => {
  it("is stable across calls for the same effect", () => {
    const first = deterministicRetryJitterSeconds(EFFECT_ID)
    const second = deterministicRetryJitterSeconds(EFFECT_ID)
    expect(first).toBe(second)
  })

  it("stays within the configured maximum", () => {
    for (const suffix of ["a", "b", "c", "d", "e", "f", "g", "h"]) {
      const jitter = deterministicRetryJitterSeconds(`${EFFECT_ID}${suffix}`, 300n)
      expect(jitter).toBeGreaterThanOrEqual(0n)
      expect(jitter).toBeLessThan(300n)
    }
  })

  it("spreads different effects rather than collapsing them onto one instant", () => {
    const jitters = new Set(
      ["a", "b", "c", "d", "e", "f", "g", "h"].map((suffix) =>
        deterministicRetryJitterSeconds(`${EFFECT_ID}${suffix}`).toString(),
      ),
    )
    expect(jitters.size).toBeGreaterThan(1)
  })

  it("treats effect ids differing only in case as different effects", () => {
    // Operation ids are derived from the exact effect id with no
    // normalization; jitter must not normalize either.
    expect(deterministicRetryJitterSeconds("rpe_ABC")).not.toBe(
      deterministicRetryJitterSeconds("rpe_abc"),
    )
  })

  it.each(["", undefined])("rejects an empty effect id (%p)", (effectId) => {
    expect(() => deterministicRetryJitterSeconds(effectId as string)).toThrow(
      RewardCapacityRetryError,
    )
  })

  it("rejects a non-positive maximum", () => {
    expect(() => deterministicRetryJitterSeconds(EFFECT_ID, 0n)).toThrow(RewardCapacityRetryError)
  })
})

describe("resolveCapacityRetryAtMs", () => {
  const base = { effectId: EFFECT_ID, deferredEpoch: 10n, epochDurationSeconds: HOUR }

  it("is identical when the same receipt is reprocessed", () => {
    // The idempotency property: duplicate reconciliation must not reschedule.
    expect(resolveCapacityRetryAtMs(base)).toBe(resolveCapacityRetryAtMs(base))
  })

  it("uses no wall clock or randomness", () => {
    const before = resolveCapacityRetryAtMs(base)
    const after = resolveCapacityRetryAtMs({ ...base })
    expect(after).toBe(before)
    // Anchored to the epoch boundary, not to "now".
    expect(before).toBeGreaterThan(Number(11n * HOUR * 1000n) - 1)
  })

  it("lands inside the immediately following epoch", () => {
    const at = BigInt(resolveCapacityRetryAtMs(base)) / 1000n
    expect(at / HOUR).toBe(11n)
  })

  it.each([HOUR, DAY])("lands in the next epoch for a %p-second epoch", (epochDurationSeconds) => {
    const at = BigInt(resolveCapacityRetryAtMs({ ...base, epochDurationSeconds })) / 1000n
    expect(at / epochDurationSeconds).toBe(11n)
  })

  it("returns milliseconds for the coordinator's next_attempt_at column", () => {
    const at = resolveCapacityRetryAtMs({ ...base, maxJitterSeconds: 1n })
    expect(at % 1000).toBe(0)
    expect(at).toBe(
      Number((11n * HOUR + CAPACITY_RETRY_CONFIRMATION_ALLOWANCE_SECONDS) * 1000n),
    )
  })

  it("refuses offsets that would skip past the next epoch", () => {
    expect(() =>
      resolveCapacityRetryAtMs({
        ...base,
        confirmationAllowanceSeconds: 3400n,
        maxJitterSeconds: 300n,
      }),
    ).toThrow(/shorter than one epoch/u)
  })

  it("keeps the shipped defaults comfortably inside the shortest configured epoch", () => {
    // Staging uses a 1-hour epoch; the defaults must fit it, not only a day.
    expect(
      CAPACITY_RETRY_CONFIRMATION_ALLOWANCE_SECONDS + CAPACITY_RETRY_MAX_JITTER_SECONDS,
    ).toBeLessThan(HOUR)
  })

  it.each([
    ["zero epoch duration", { epochDurationSeconds: 0n }],
    ["negative epoch", { deferredEpoch: -1n }],
    ["negative allowance", { confirmationAllowanceSeconds: -1n }],
  ])("rejects %s", (_label, patch) => {
    expect(() => resolveCapacityRetryAtMs({ ...base, ...patch })).toThrow(RewardCapacityRetryError)
  })
})

describe("crossCheckDeferredEpoch", () => {
  it("accepts an event epoch matching the receipt block", () => {
    const result = crossCheckDeferredEpoch({
      deferredEpoch: 10n,
      receiptBlockTimestampSeconds: 10n * HOUR + 5n,
      epochDurationSeconds: HOUR,
    })
    expect(result.ok).toBe(true)
    expect(result.receiptEpoch).toBe(10n)
  })

  it("accepts the exact boundary instant", () => {
    expect(
      crossCheckDeferredEpoch({
        deferredEpoch: 10n,
        receiptBlockTimestampSeconds: 10n * HOUR,
        epochDurationSeconds: HOUR,
      }).ok,
    ).toBe(true)
  })

  it("rejects a mismatch and names configuration as the cause", () => {
    // The pinned contract guarantees equality, so a mismatch means the vault
    // address, epoch duration or ABI is misconfigured — not a contract fault.
    const result = crossCheckDeferredEpoch({
      deferredEpoch: 10n,
      receiptBlockTimestampSeconds: 11n * HOUR,
      epochDurationSeconds: HOUR,
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toContain("configuration is wrong")
  })

  it("catches a locally-misconfigured epoch duration", () => {
    // Same block, but the API believes epochs are a day while the vault uses
    // an hour: the computed epoch diverges wildly.
    const result = crossCheckDeferredEpoch({
      deferredEpoch: 240n,
      receiptBlockTimestampSeconds: 240n * HOUR,
      epochDurationSeconds: DAY,
    })
    expect(result.ok).toBe(false)
    expect(result.receiptEpoch).toBe(10n)
  })

  it.each([
    ["zero epoch duration", { epochDurationSeconds: 0n }],
    ["negative timestamp", { receiptBlockTimestampSeconds: -1n }],
  ])("rejects %s without asserting an epoch", (_label, patch) => {
    const result = crossCheckDeferredEpoch({
      deferredEpoch: 1n,
      receiptBlockTimestampSeconds: HOUR,
      epochDurationSeconds: HOUR,
      ...patch,
    })
    expect(result.ok).toBe(false)
    expect(result.receiptEpoch).toBeNull()
  })
})
