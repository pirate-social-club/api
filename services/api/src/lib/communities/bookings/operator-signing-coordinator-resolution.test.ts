import { describe, expect, test } from "bun:test"

import { assertManualRewardResolutionEvidence } from "./operator-signing-coordinator-do"

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
