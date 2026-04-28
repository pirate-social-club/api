import { describe, expect, test } from "bun:test"
import { buildMembershipGateSummary, evaluateMembershipGateRules, satisfiesMembershipGateRules } from "../src/lib/communities/membership/gates"
import { buildDefaultVerificationCapabilities } from "../src/lib/verification/verification-capabilities"
import type { User } from "../src/types"

type CapabilityState = "unverified" | "verified" | "expired"

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

function makeGenderRule(requiredValue: "M" | "F"): CommunityGateRuleRow {
  return {
    gate_rule_id: "gr_gender",
    scope: "membership",
    gate_family: "identity_proof",
    gate_type: "gender",
    proof_requirements_json: JSON.stringify([
      { proof_type: "gender", accepted_providers: ["self"], config: { required_value: requiredValue } },
    ]),
    chain_namespace: null,
    gate_config_json: null,
    status: "active",
  }
}

function makeUser(overrides: {
  gender?: { state: CapabilityState; provider?: "self"; value?: "M" | "F" | null }
}): User {
  const caps = buildDefaultVerificationCapabilities()
  return {
    user_id: "usr_test",
    verification_state: "verified",
    verification_capabilities: {
      ...caps,
      unique_human: {
        ...caps.unique_human,
        state: "verified",
        provider: "self",
      },
      gender: {
        ...caps.gender,
        ...(overrides.gender ?? {}),
      },
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

describe("gender gate evaluation", () => {
  test("builds gender summary with required_value", () => {
    const summary = buildMembershipGateSummary(makeGenderRule("M"))
    expect(summary.gate_type).toBe("gender")
    expect(summary.accepted_providers).toEqual(["self"])
    expect(summary.required_value).toBe("M")
  })

  test("returns missing gender when user lacks verification", async () => {
    const result = await evaluateMembershipGateRules({ env: {}, rules: [makeGenderRule("M")], user: makeUser({
      gender: { state: "unverified" },
    }), walletAttachments: [] })
    expect(result.satisfied).toBe(false)
    expect(result.missingCapabilities).toEqual(["gender"])
    expect(result.suggestedVerificationProvider).toBe("self")
  })

  test("returns gender_mismatch when verified gender differs", async () => {
    const result = await evaluateMembershipGateRules({ env: {}, rules: [makeGenderRule("M")], user: makeUser({
      gender: { state: "verified", provider: "self", value: "F" },
    }), walletAttachments: [] })
    expect(result.satisfied).toBe(false)
    expect(result.mismatchReasons).toContain("gender_mismatch")
  })

  test("returns satisfied when verified gender matches", async () => {
    const result = await evaluateMembershipGateRules({ env: {}, rules: [makeGenderRule("F")], user: makeUser({
      gender: { state: "verified", provider: "self", value: "F" },
    }), walletAttachments: [] })
    expect(result.satisfied).toBe(true)
    expect(result.missingCapabilities).toEqual([])
    expect(result.mismatchReasons).toEqual([])
    expect(await satisfiesMembershipGateRules({ env: {}, rules: [makeGenderRule("F")], user: makeUser({
      gender: { state: "verified", provider: "self", value: "F" },
    }), walletAttachments: [] })).toBe(true)
  })
})
