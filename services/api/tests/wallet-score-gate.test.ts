import { describe, expect, test } from "bun:test"
import { buildMembershipGateSummary, evaluateMembershipGateRules } from "../src/lib/communities/membership/gates"
import { buildDefaultVerificationCapabilities } from "../src/lib/verification/verification-capabilities"
import type { User } from "../src/types"

type CommunityGateRuleRow = {
  gate_rule_id: string
  scope: "membership" | "viewer" | "posting"
  gate_family: "identity_proof" | "token_holding"
  gate_type: string
  proof_requirements_json: string | null
  chain_namespace: string | null
  gate_config_json: string | null
  status: "active" | "disabled"
}

function makeWalletScoreRule(minimumScore: number): CommunityGateRuleRow {
  return {
    gate_rule_id: "gr_wallet_score",
    scope: "membership",
    gate_family: "identity_proof",
    gate_type: "wallet_score",
    proof_requirements_json: JSON.stringify([
      { proof_type: "wallet_score", accepted_providers: ["passport"], config: { minimum_score: minimumScore } },
    ]),
    chain_namespace: null,
    gate_config_json: null,
    status: "active",
  }
}

function makeUser(score: number | null, passingScore = true): User {
  const caps = buildDefaultVerificationCapabilities()
  return {
    user_id: "usr_wallet_score",
    verification_state: "verified",
    verification_capabilities: {
      ...caps,
      unique_human: { ...caps.unique_human, state: "verified", provider: "self" },
      wallet_score: score == null
        ? caps.wallet_score
        : {
          ...caps.wallet_score,
          state: "verified",
          provider: "passport",
          proof_type: "wallet_score",
          score,
          score_threshold: 20,
          passing_score: passingScore,
        },
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

describe("wallet score gate evaluation", () => {
  test("builds summary with minimum_score", () => {
    expect(buildMembershipGateSummary(makeWalletScoreRule(20)).minimum_score).toBe(20)
  })

  test("returns missing wallet_score when user lacks Passport score", async () => {
    const result = await evaluateMembershipGateRules({ env: {}, rules: [makeWalletScoreRule(20)], user: makeUser(null), walletAttachments: [] })
    expect(result.satisfied).toBe(false)
    expect(result.missingCapabilities).toEqual(["wallet_score"])
    expect(result.suggestedVerificationProvider).toBe("passport")
  })

  test("returns wallet_score_too_low when score is below threshold", async () => {
    const result = await evaluateMembershipGateRules({ env: {}, rules: [makeWalletScoreRule(20)], user: makeUser(19), walletAttachments: [] })
    expect(result.satisfied).toBe(false)
    expect(result.mismatchReasons).toContain("wallet_score_too_low")
  })

  test("returns satisfied when score meets threshold", async () => {
    const result = await evaluateMembershipGateRules({ env: {}, rules: [makeWalletScoreRule(20)], user: makeUser(20), walletAttachments: [] })
    expect(result.satisfied).toBe(true)
    expect(result.mismatchReasons).toEqual([])
  })
})
