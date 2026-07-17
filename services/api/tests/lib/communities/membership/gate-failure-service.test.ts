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
        outcome: "action_required",
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
        outcome: "action_required",
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
        outcome: "action_required",
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
        outcome: "action_required",
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

  test("uses join message for community_join failures regardless of capabilities", () => {
    const result = catchGateFailure({
      evaluation: {
        satisfied: false,
        outcome: "action_required",
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
      outcome: "terminal_mismatch",
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

  test("keeps NFT failures actionable with wallet-specific remediation", () => {
    const result = catchGateFailure({
      evaluation: {
        satisfied: false,
        outcome: "action_required",
        trace: {
          kind: "gate",
          gate_type: "erc721_holding",
          provider: "wallet",
          passed: false,
          reason: "erc721_holding_required",
        },
        requiredActionSet: {
          kind: "set",
          mode: "all",
          items: [{
            kind: "action",
            provider: "wallet",
            capability: "erc721_holding",
            chain_namespace: "eip155:1",
            contract_address: "0x0000000000000000000000000000000000000001",
            min_quantity: 1,
          }],
        },
      },
      gateSummaries: [{
        gate_type: "erc721_holding",
        chain_namespace: "eip155:1",
        contract_address: "0x0000000000000000000000000000000000000001",
      }],
      walletScoreStatus: null,
      altchaScope: "post_create",
    })

    expect(result.message).toBe("Connect a wallet holding the required collectible to post in this community")
    expect(result.details.failure_reason).toBe("erc721_holding_required")
  })

  test("uses asset-specific remediation for balance gates", () => {
    const result = catchGateFailure({
      evaluation: {
        satisfied: false,
        outcome: "action_required",
        trace: { kind: "gate", gate_type: "asset_balance", provider: "wallet", passed: false, reason: "asset_balance_required" },
        requiredActionSet: {
          kind: "set",
          mode: "all",
          items: [{
            kind: "action",
            provider: "wallet",
            capability: "asset_balance",
            asset_id: "eip155:1/slip44:60",
            required_amount_atomic: "10",
            current_amount_atomic: "7",
            shortfall_amount_atomic: "3",
          }],
        },
      },
      gateSummaries: [{ gate_type: "asset_balance", asset_id: "eip155:1/slip44:60", min_amount_atomic: "10" }],
      walletScoreStatus: null,
      altchaScope: "post_create",
    })

    expect(result.message).toBe("Connect a wallet holding the required asset to post in this community")
    // An insufficient balance is its own reason: reporting "missing_verification"
    // sends a member to identity verification that cannot help, and "unsupported"
    // renders dead-end copy.
    expect(result.details.failure_reason).toBe("asset_balance_too_low")
    // The exact shortfall must survive alongside the reason so the member can be
    // told how much more they need.
    const gateEvaluation = result.details.gate_evaluation as
      | { required_action_set?: { items?: unknown[] } | null }
      | undefined
    expect(gateEvaluation?.required_action_set?.items?.[0]).toMatchObject({
      capability: "asset_balance",
      required_amount_atomic: "10",
      current_amount_atomic: "7",
      shortfall_amount_atomic: "3",
    })
  })

  test("renders missing RPC configuration as a provider outage", () => {
    const evaluation = {
      satisfied: false,
      outcome: "provider_unavailable",
      trace: {
        kind: "gate",
        gate_type: "erc721_holding",
        provider: "wallet",
        passed: false,
        reason: "ethereum_rpc_not_configured",
      },
      requiredActionSet: null,
    } as const

    const result = catchGateFailure({
      evaluation,
      gateSummaries: [{
        gate_type: "erc721_holding",
        chain_namespace: "eip155:1",
        contract_address: "0x0000000000000000000000000000000000000001",
      }],
      walletScoreStatus: null,
    })

    expect(gateFailureReasonFromPolicyEvaluation(evaluation)).toBe("token_inventory_unavailable")
    expect(result.message).toBe("Collectible inventory could not be checked right now")
    expect(result.details.failure_reason).toBe("token_inventory_unavailable")
  })
})
