import { describe, expect, test } from "bun:test"
import { decideNonMemberCommentAccess } from "./comment-service"
import { HttpError } from "../errors"
import type { GatePolicyEvaluation, RequiredActionSet } from "../communities/membership/gate-types"

// Pins the non-member comment-access decision. Invariants:
//  - the provisional/solvable path fires ONLY when the missing capability set is
//    exactly {altcha_pow} (a future gate type stays opaque until opted in);
//  - a proof only helps a PoW-only gate — it never rescues an attribute gate;
//  - the pure decision never consumes a proof or writes a row (that is the
//    caller's verify-then-persist job).

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

function decide(actionSet: RequiredActionSet | null, hasProof: boolean): { result?: string; error?: HttpError } {
  try {
    return { result: decideNonMemberCommentAccess({
      communityId: "cmt_test",
      evaluation: evaluation(actionSet),
      gateSummaries: [],
      walletScoreStatus: null,
      hasProof,
    }) }
  } catch (error) {
    if (error instanceof HttpError) return { error }
    throw error
  }
}

describe("decideNonMemberCommentAccess", () => {
  test("PoW-only + proof present → provisional_participant (no throw)", () => {
    const { result, error } = decide(powOnly, true)
    expect(error).toBeUndefined()
    expect(result).toBe("provisional_participant")
  })

  test("PoW-only + NO proof → solvable, COMMENT-scoped gate_failed (client fetches challenge, retries)", () => {
    const { error } = decide(powOnly, false)
    expect(error?.status).toBe(403)
    expect(error?.code).toBe("gate_failed")
    expect(error?.message.toLowerCase()).toContain("comment")
    expect((error?.details as Record<string, unknown>)?.suggested_verification_intent).toBe("comment_create")
    expect((error?.details as Record<string, unknown>)?.missing_capabilities).toEqual(["altcha_pow"])
  })

  test("attribute gate (nationality) + proof present → opaque 404 (a proof cannot satisfy an attribute gate)", () => {
    const { result, error } = decide(nationalityGate, true)
    expect(result).toBeUndefined()
    expect(error?.status).toBe(404)
    expect(error?.code).toBe("not_found")
    expect(error?.message).toBe("Community not found")
    expect(error?.logCode).toBe("community_membership_required")
  })

  test("attribute gate + no proof → opaque 404", () => {
    expect(decide(nationalityGate, false).error?.logCode).toBe("community_membership_required")
  })

  test("PoW + attribute (missing set ≠ {altcha_pow}) + proof → opaque 404, NOT provisional", () => {
    const { result, error } = decide(powPlusAttribute, true)
    expect(result).toBeUndefined()
    expect(error?.status).toBe(404)
    expect(error?.logCode).toBe("community_membership_required")
  })

  test("no required action set → opaque 404", () => {
    expect(decide(null, true).error?.status).toBe(404)
  })
})
