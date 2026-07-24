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
      vaultEvent: { status: "matched" },
    })).toThrow("vault transfer event matched")
  })
})
