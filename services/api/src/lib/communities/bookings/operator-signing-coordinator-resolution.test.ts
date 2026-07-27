import { describe, expect, test } from "bun:test"

import {
  assertManualRewardResolutionEvidence,
  rewardVaultDecisionInputFromRow,
} from "./operator-signing-coordinator-do"

describe("manual rewards settlement disposition evidence", () => {
  test("allows confirmation only for a machine-observed successful receipt", () => {
    expect(() => assertManualRewardResolutionEvidence({
      resolution: "confirmed",
      liveness: "success",
    })).not.toThrow()
    for (const liveness of ["failed", "pending", "absent"] as const) {
      expect(() => assertManualRewardResolutionEvidence({
        resolution: "confirmed",
        liveness,
      })).toThrow("without a successful receipt")
    }
  })

  test("allows failed_onchain only for a machine-observed failed receipt", () => {
    expect(() => assertManualRewardResolutionEvidence({
      resolution: "failed_onchain",
      liveness: "failed",
    })).not.toThrow()
    for (const liveness of ["success", "pending", "absent"] as const) {
      expect(() => assertManualRewardResolutionEvidence({
        resolution: "failed_onchain",
        liveness,
      })).toThrow("without a failed receipt")
    }
  })

  test("independently forbids failed_onchain after the vault event matched", () => {
    expect(() => assertManualRewardResolutionEvidence({
      resolution: "failed_onchain",
      liveness: "success",
      decision: { disposition: "confirmed", reason: "matched", evidence: null as never },
    })).toThrow("vault transfer event matched")
  })
})

test("forbids failing an effect the vault deferred for capacity", () => {
  // A deferral is a LIVE claim: the operation id was never consumed, so
  // disposing it as failed and re-cashing-out is the double-pay this guards.
  expect(() =>
    assertManualRewardResolutionEvidence({
      resolution: "failed_onchain",
      liveness: "success",
      decision: {
        disposition: "capacity_deferred",
        reason: "deferred",
        deferredEpoch: 1n,
        retryAtMs: 0,
        evidence: null as never,
      },
    }),
  ).toThrow(/deferred for epoch capacity/u)
})

test("forbids confirming an effect the vault deferred for capacity", () => {
  expect(() =>
    assertManualRewardResolutionEvidence({
      resolution: "confirmed",
      liveness: "success",
      decision: {
        disposition: "capacity_deferred",
        reason: "deferred",
        deferredEpoch: 1n,
        retryAtMs: 0,
        evidence: null as never,
      },
    }),
  ).toThrow(/deferred for epoch capacity/u)
})

describe("effect id binding", () => {
  // A REALISTIC row: the idempotency key is a JSON envelope and differs from
  // the booking_id that actually holds the effect id. Every fixture that sets
  // them equal hides the bug this guards.
  const row = {
    effect_kind: "reward_cashout",
    booking_id: "rpe_0123456789abcdef0123456789abcdef",
    idempotency_key: JSON.stringify([
      "reward_payout",
      "user:usr_abc:reward_payout:rpe_0123456789abcdef0123456789abcdef",
    ]),
    recipient_address: "0x000000000000000000000000000000000000dEaD",
    amount_cents: 50,
    amount_atomic: null,
    nonce: 7,
    signed_tx: "0x02",
    tx_hash: `0x${"ab".repeat(32)}`,
  }

  test("takes the effect id from booking_id, never from the idempotency envelope", () => {
    // keccak(effectId) is the operation id. Using the envelope would derive a
    // different operation id, fail every byte-exact verification, and leave the
    // manual-resolution guard unable to see a proven settlement.
    const input = rewardVaultDecisionInputFromRow(row)
    expect(input.effectId).toBe(row.booking_id)
    expect(input.effectId).not.toBe(row.idempotency_key)
  })

  test("sources a cashout amount from cents and a refund amount from atomic", () => {
    const cashout = rewardVaultDecisionInputFromRow(row)
    expect(cashout.amountCents).toBe(50)
    expect(cashout.amountAtomic).toBeUndefined()

    const refund = rewardVaultDecisionInputFromRow({
      ...row,
      effect_kind: "reward_funding_refund",
      booking_id: "rcf_0123456789abcdef0123456789abcdef",
      amount_atomic: "500000",
    })
    expect(refund.amountAtomic).toBe("500000")
    expect(refund.amountCents).toBeUndefined()
    expect(refund.effectId).toBe("rcf_0123456789abcdef0123456789abcdef")
  })
})
