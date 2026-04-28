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

function makeMinimumAgeRule(minimumAge: number): CommunityGateRuleRow {
  return {
    gate_rule_id: "gr_min_age",
    scope: "membership",
    gate_family: "identity_proof",
    gate_type: "minimum_age",
    proof_requirements_json: JSON.stringify([
      { proof_type: "minimum_age", accepted_providers: ["self"], config: { minimum_age: minimumAge } },
    ]),
    chain_namespace: null,
    gate_config_json: null,
    status: "active",
  }
}

function makeUser(minimumAge: number | null): User {
  const caps = buildDefaultVerificationCapabilities()
  return {
    user_id: "usr_age",
    verification_state: "verified",
    verification_capabilities: {
      ...caps,
      unique_human: { ...caps.unique_human, state: "verified", provider: "self" },
      minimum_age: minimumAge == null
        ? caps.minimum_age
        : { ...caps.minimum_age, state: "verified", provider: "self", value: minimumAge },
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

describe("minimum age gate evaluation", () => {
  test("builds summary with required_minimum_age", () => {
    expect(buildMembershipGateSummary(makeMinimumAgeRule(30)).required_minimum_age).toBe(30)
  })

  test("returns missing minimum_age when user lacks age proof", async () => {
    const result = await evaluateMembershipGateRules({ env: {}, rules: [makeMinimumAgeRule(30)], user: makeUser(null), walletAttachments: [] })
    expect(result.satisfied).toBe(false)
    expect(result.missingCapabilities).toEqual(["minimum_age"])
  })

  test("returns minimum_age_mismatch when proof is below threshold", async () => {
    const result = await evaluateMembershipGateRules({ env: {}, rules: [makeMinimumAgeRule(30)], user: makeUser(21), walletAttachments: [] })
    expect(result.satisfied).toBe(false)
    expect(result.mismatchReasons).toContain("minimum_age_mismatch")
  })

  test("returns satisfied when proof meets threshold", async () => {
    const result = await evaluateMembershipGateRules({ env: {}, rules: [makeMinimumAgeRule(30)], user: makeUser(30), walletAttachments: [] })
    expect(result.satisfied).toBe(true)
  })
})
