/**
 * Retry timing for capacity-deferred rewards effects.
 *
 * Every value here is a function of DURABLE inputs only — the effect ID, the
 * deferred epoch, the epoch duration, and source-controlled constants. Nothing
 * reads the wall clock or a random source.
 *
 * That is the property that makes deferral processing idempotent: reconciling
 * the same receipt twice must compute the identical `next_attempt_at`, or a
 * duplicate reconciliation silently reschedules the effect and the "one durable
 * retry per deferral" invariant is lost.
 */

import { id } from "ethers"

/** Allowance for the retry to land after the boundary has actually confirmed. */
export const CAPACITY_RETRY_CONFIRMATION_ALLOWANCE_SECONDS = 60n

/**
 * Spread across effects deferred in the same epoch, so a queue does not
 * stampede the vault the instant capacity reopens.
 *
 * Together with the allowance this must stay well inside one epoch; the
 * shortest configured epoch is the staging rehearsal's 3600s.
 */
export const CAPACITY_RETRY_MAX_JITTER_SECONDS = 300n

export class RewardCapacityRetryError extends Error {}

/**
 * Deterministic per-effect jitter.
 *
 * Derived from the effect ID rather than randomness so the same effect always
 * receives the same offset. Uses keccak of the exact effect ID — the same
 * one-way digest the operation ID is built from — with no normalization, so
 * two effect IDs differing only in case are different effects here too.
 */
export function deterministicRetryJitterSeconds(
  effectId: string,
  maxJitterSeconds: bigint = CAPACITY_RETRY_MAX_JITTER_SECONDS,
): bigint {
  if (typeof effectId !== "string" || effectId.length === 0) {
    throw new RewardCapacityRetryError("effect id must be a non-empty string")
  }
  if (maxJitterSeconds <= 0n) {
    throw new RewardCapacityRetryError("max jitter must be positive")
  }
  return BigInt(id(effectId)) % maxJitterSeconds
}

/**
 * When a deferred effect becomes eligible again, in epoch milliseconds, ready
 * for the coordinator's `next_attempt_at` column.
 *
 * Returned in milliseconds deliberately: the coordinator stores epoch millis,
 * and the vault reasons in seconds. Converting here keeps the multiplication in
 * one place rather than at each call site.
 */
export function resolveCapacityRetryAtMs(input: {
  effectId: string
  deferredEpoch: bigint
  epochDurationSeconds: bigint
  confirmationAllowanceSeconds?: bigint
  maxJitterSeconds?: bigint
}): number {
  const allowance =
    input.confirmationAllowanceSeconds ?? CAPACITY_RETRY_CONFIRMATION_ALLOWANCE_SECONDS
  const maxJitter = input.maxJitterSeconds ?? CAPACITY_RETRY_MAX_JITTER_SECONDS

  if (input.epochDurationSeconds <= 0n) {
    throw new RewardCapacityRetryError("epoch duration must be positive")
  }
  if (input.deferredEpoch < 0n) {
    throw new RewardCapacityRetryError("deferred epoch must not be negative")
  }
  if (allowance < 0n) {
    throw new RewardCapacityRetryError("confirmation allowance must not be negative")
  }
  // The retry must land inside the IMMEDIATELY following epoch. A larger total
  // would silently skip epochs and strand the effect.
  if (allowance + maxJitter >= input.epochDurationSeconds) {
    throw new RewardCapacityRetryError(
      "confirmation allowance plus maximum jitter must be shorter than one epoch",
    )
  }

  const jitter = deterministicRetryJitterSeconds(input.effectId, maxJitter)
  const seconds = (input.deferredEpoch + 1n) * input.epochDurationSeconds + allowance + jitter
  const millis = seconds * 1000n
  if (millis > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RewardCapacityRetryError("computed retry time exceeds a safe integer")
  }
  return Number(millis)
}

export type DeferredEpochCrossCheck =
  | { ok: true; receiptEpoch: bigint }
  | { ok: false; reason: string; receiptEpoch: bigint | null }

/**
 * Cross-checks the deferral event's epoch against the receipt's block.
 *
 * The pinned contract computes `block.timestamp / epochDuration`, so these must
 * agree. A mismatch does not indicate a contract fault — it indicates the
 * CONFIGURATION is wrong: wrong vault address, wrong locally-configured epoch
 * duration, or an ABI mismatch. Catching it before scheduling turns a silently
 * wrong retry time into a loud configuration error.
 */
export function crossCheckDeferredEpoch(input: {
  deferredEpoch: bigint
  receiptBlockTimestampSeconds: bigint
  epochDurationSeconds: bigint
}): DeferredEpochCrossCheck {
  if (input.epochDurationSeconds <= 0n) {
    return { ok: false, reason: "epoch duration must be positive", receiptEpoch: null }
  }
  if (input.receiptBlockTimestampSeconds < 0n) {
    return { ok: false, reason: "receipt block timestamp must not be negative", receiptEpoch: null }
  }
  // The classifier can only produce an unsigned epoch, but this is a pure
  // boundary: reject an impossible input rather than let two negative values
  // compare equal under some future reuse.
  if (input.deferredEpoch < 0n) {
    return { ok: false, reason: "deferred epoch must not be negative", receiptEpoch: null }
  }
  const receiptEpoch = input.receiptBlockTimestampSeconds / input.epochDurationSeconds
  if (receiptEpoch !== input.deferredEpoch) {
    return {
      ok: false,
      reason:
        `deferral event epoch ${input.deferredEpoch} does not match the receipt block's epoch`
        + ` ${receiptEpoch}; vault address, epoch duration or ABI configuration is wrong`,
      receiptEpoch,
    }
  }
  return { ok: true, receiptEpoch }
}
