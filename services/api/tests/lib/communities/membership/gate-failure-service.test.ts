import { describe, expect, test } from "bun:test"
import {
  gateFailureReasonFromPolicyEvaluation,
  throwUnsatisfiedMembershipGate,
} from "../../../../src/lib/communities/membership/gate-failure-service"

describe("throwUnsatisfiedMembershipGate", () => {
  function catchGateFailure(input: Parameters<typeof throwUnsatisfiedMembershipGate>[0]): {
    message: string
    details: Record<string, unknown>
  } {
    try {
      throwUnsatisfiedMembershipGate(input)
    } catch (error: unknown) {
      if (error instanceof Error && "details" in error) {
        return {
          message: error.message,
          details: error.details as Record<string, unknown>,
        }
      }
      throw error
    }
    throw new Error("Expected throwUnsatisfiedMembershipGate to throw")
  }

  test("uses proof-of-work message for ALTCHA-only post_create failures", () => {
    const result = catchGateFailure({
      evaluation: {
        satisfied: false,
        trace: { kind: "op", op: "and", passed: false, children: [] },
        requiredActionSet: {
          kind: "set",
          mode: "all",
          items: [
            { kind: "action", provider: "altcha", capability: "altcha_pow", scope: "post_create" },
          ],
        },
      },
      gateSummaries: [{ gate_type: "altcha_pow" }],
      walletScoreStatus: null,
      altchaScope: "post_create",
    })
    expect(result.message).toBe("Proof-of-work is required to post in this community")
  })

  test("uses generic verification message for post_create wallet_score failures", () => {
    const result = catchGateFailure({
      evaluation: {
        satisfied: false,
        trace: { kind: "op", op: "and", passed: false, children: [] },
        requiredActionSet: {
          kind: "set",
          mode: "all",
          items: [
            { kind: "action", provider: "passport", capability: "wallet_score", minimum_score: 20, actual_score: 10 },
          ],
        },
      },
      gateSummaries: [{ gate_type: "wallet_score" }],
      walletScoreStatus: null,
      altchaScope: "post_create",
    })
    expect(result.message).toBe("Verification is required to post in this community")
  })

  test("uses generic verification message for post_create mixed failures", () => {
    const result = catchGateFailure({
      evaluation: {
        satisfied: false,
        trace: { kind: "op", op: "and", passed: false, children: [] },
        requiredActionSet: {
          kind: "set",
          mode: "all",
          items: [
            { kind: "action", provider: "altcha", capability: "altcha_pow", scope: "post_create" },
            { kind: "action", provider: "passport", capability: "wallet_score", minimum_score: 20, actual_score: null },
          ],
        },
      },
      gateSummaries: [{ gate_type: "altcha_pow" }, { gate_type: "wallet_score" }],
      walletScoreStatus: null,
      altchaScope: "post_create",
    })
    expect(result.message).toBe("Verification is required to post in this community")
  })

  test("uses proof-of-work message for ALTCHA-only comment_create failures", () => {
    const result = catchGateFailure({
      evaluation: {
        satisfied: false,
        trace: { kind: "op", op: "and", passed: false, children: [] },
        requiredActionSet: {
          kind: "set",
          mode: "all",
          items: [
            { kind: "action", provider: "altcha", capability: "altcha_pow", scope: "comment_create" },
          ],
        },
      },
      gateSummaries: [{ gate_type: "altcha_pow" }],
      walletScoreStatus: null,
      altchaScope: "comment_create",
    })
    expect(result.message).toBe("Proof-of-work is required to comment in this community")
  })

  test("uses proof-of-work message for ALTCHA-only vote failures", () => {
    const result = catchGateFailure({
      evaluation: {
        satisfied: false,
        trace: { kind: "op", op: "and", passed: false, children: [] },
        requiredActionSet: {
          kind: "set",
          mode: "all",
          items: [
            { kind: "action", provider: "altcha", capability: "altcha_pow", scope: "vote" },
          ],
        },
      },
      gateSummaries: [{ gate_type: "altcha_pow" }],
      walletScoreStatus: null,
      altchaScope: "vote",
    })
    expect(result.message).toBe("Proof-of-work is required to vote in this community")
  })

  test("uses join message for community_join failures regardless of capabilities", () => {
    const result = catchGateFailure({
      evaluation: {
        satisfied: false,
        trace: { kind: "op", op: "and", passed: false, children: [] },
        requiredActionSet: {
          kind: "set",
          mode: "all",
          items: [
            { kind: "action", provider: "altcha", capability: "altcha_pow", scope: "community_join" },
          ],
        },
      },
      gateSummaries: [{ gate_type: "altcha_pow" }],
      walletScoreStatus: null,
      altchaScope: "community_join",
    })
    expect(result.message).toBe("Verification is required to join this community")
  })

  test("maps provider_not_accepted trace reason to provider failure details", () => {
    const evaluation = {
      satisfied: false,
      trace: {
        kind: "gate",
        gate_type: "nationality",
        provider: "self",
        passed: false,
        reason: "provider_not_accepted",
      },
      requiredActionSet: null,
    } as const

    const result = catchGateFailure({
      evaluation,
      gateSummaries: [{ gate_type: "nationality", accepted_providers: ["self"] }],
      walletScoreStatus: null,
    })

    expect(gateFailureReasonFromPolicyEvaluation(evaluation)).toBe("provider_not_accepted")
    expect(result.message).toBe("Your verification method does not satisfy this community requirement")
    expect(result.details.failure_reason).toBe("provider_not_accepted")
  })
})
