import { describe, expect, test } from "bun:test"
import { throwDiscriminatedNonMemberCommentGate } from "./comment-service"
import { HttpError } from "../errors"
import type { GatePolicyEvaluation, RequiredActionSet } from "../communities/membership/gate-types"

// Pins the non-member comment-gate discriminator (commit: error-only, no writes).
// The invariant under test: the solvable path fires *only* when the missing
// capability set is exactly {altcha_pow}. Any other gate stays opaque. This
// guards against a future gate type silently leaking its requirements via a
// solvable gate_failed.

function evaluation(actionSet: RequiredActionSet | null): GatePolicyEvaluation {
  return {
    satisfied: false,
    trace: { kind: "op", op: "and", passed: false, children: [] },
    requiredActionSet: actionSet,
  }
}

const powOnly: RequiredActionSet = {
  kind: "set",
  mode: "all",
  items: [{ kind: "action", provider: "altcha", capability: "altcha_pow", scope: "comment_create" }],
}

const nationalityGate: RequiredActionSet = {
  kind: "set",
  mode: "all",
  items: [{ kind: "action", provider: "self", capability: "nationality", allowed_countries: ["US"] }],
}

const powPlusAttribute: RequiredActionSet = {
  kind: "set",
  mode: "all",
  items: [
    { kind: "action", provider: "altcha", capability: "altcha_pow", scope: "comment_create" },
    { kind: "action", provider: "self", capability: "nationality", allowed_countries: ["US"] },
  ],
}

function captureThrow(actionSet: RequiredActionSet | null): HttpError {
  try {
    throwDiscriminatedNonMemberCommentGate({
      communityId: "cmt_test",
      evaluation: evaluation(actionSet),
      gateSummaries: [],
      walletScoreStatus: null,
    })
  } catch (error) {
    if (error instanceof HttpError) return error
    throw error
  }
  throw new Error("discriminator did not throw")
}

describe("throwDiscriminatedNonMemberCommentGate", () => {
  test("missing set exactly {altcha_pow} → solvable, COMMENT-scoped gate_failed (not join)", () => {
    const err = captureThrow(powOnly)
    expect(err.status).toBe(403)
    expect(err.code).toBe("gate_failed")
    // Scope interaction: reusing the membership gate machinery with
    // altchaScope:"comment_create" must yield comment-scoped output.
    expect(err.message.toLowerCase()).toContain("comment")
    expect((err.details as Record<string, unknown>)?.suggested_verification_intent).toBe("comment_create")
    expect((err.details as Record<string, unknown>)?.missing_capabilities).toEqual(["altcha_pow"])
  })

  test("attribute gate (nationality) → opaque community_membership_required 404", () => {
    const err = captureThrow(nationalityGate)
    expect(err.status).toBe(404)
    expect(err.code).toBe("not_found")
    expect(err.message).toBe("Community not found")
    expect(err.logCode).toBe("community_membership_required")
  })

  test("altcha_pow + an attribute (missing set ≠ {altcha_pow}) → opaque 404, NOT solvable", () => {
    const err = captureThrow(powPlusAttribute)
    expect(err.status).toBe(404)
    expect(err.logCode).toBe("community_membership_required")
  })

  test("no required action set → opaque 404", () => {
    const err = captureThrow(null)
    expect(err.status).toBe(404)
    expect(err.logCode).toBe("community_membership_required")
  })
})
