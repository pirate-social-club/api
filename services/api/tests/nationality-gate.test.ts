import { describe, expect, test } from "bun:test"
import { buildMembershipGateSummary, evaluateMembershipGateRules, satisfiesMembershipGateRules } from "../src/lib/communities/community-membership-store"
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

function makeNationalityRule(requiredValue: string): CommunityGateRuleRow {
  return {
    gate_rule_id: "gr_test",
    scope: "membership",
    gate_family: "identity_proof",
    gate_type: "nationality",
    proof_requirements_json: JSON.stringify([
      { proof_type: "nationality", accepted_providers: ["self"], config: { required_value: requiredValue } },
    ]),
    chain_namespace: null,
    gate_config_json: null,
    status: "active",
  }
}

function makeUniqueHumanRule(): CommunityGateRuleRow {
  return {
    gate_rule_id: "gr_uh",
    scope: "membership",
    gate_family: "identity_proof",
    gate_type: "unique_human",
    proof_requirements_json: JSON.stringify([
      { proof_type: "unique_human", accepted_providers: ["self"] },
    ]),
    chain_namespace: null,
    gate_config_json: null,
    status: "active",
  }
}

function makeUser(overrides: {
  nationality?: { state: CapabilityState; provider?: "self"; value?: string }
  uniqueHuman?: { state: CapabilityState; provider?: "self" | "very" }
}): User {
  const caps = buildDefaultVerificationCapabilities()
  return {
    user_id: "usr_test",
    verification_state: "verified",
    verification_capabilities: {
      ...caps,
      unique_human: {
        ...caps.unique_human,
        ...(overrides.uniqueHuman ?? {}),
      },
      nationality: {
        ...caps.nationality,
        ...(overrides.nationality ?? {}),
      },
    },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

describe("buildMembershipGateSummary", () => {
  test("builds nationality summary with required_value", () => {
    const rule = makeNationalityRule("US")
    const summary = buildMembershipGateSummary(rule)
    expect(summary.gate_type).toBe("nationality")
    expect(summary.accepted_providers).toEqual(["self"])
    expect(summary.required_value).toBe("US")
  })

  test("builds nationality summary from gate_config fallback", () => {
    const rule: CommunityGateRuleRow = {
      gate_rule_id: "gr_test",
      scope: "membership",
      gate_family: "identity_proof",
      gate_type: "nationality",
      proof_requirements_json: JSON.stringify([
        { proof_type: "nationality", accepted_providers: ["self"] },
      ]),
      chain_namespace: null,
      gate_config_json: JSON.stringify({ required_value: "AR" }),
      status: "active",
    }
    const summary = buildMembershipGateSummary(rule)
    expect(summary.required_value).toBe("AR")
  })

  test("builds summary for unique_human gate", () => {
    const rule = makeUniqueHumanRule()
    const summary = buildMembershipGateSummary(rule)
    expect(summary.gate_type).toBe("unique_human")
    expect(summary.accepted_providers).toEqual(["self"])
  })
})

describe("evaluateMembershipGateRules", () => {
  test("returns satisfied when user has matching nationality", async () => {
    const user = makeUser({ nationality: { state: "verified", provider: "self", value: "US" } })
    const rules = [makeNationalityRule("US")]
    const result = await evaluateMembershipGateRules({ env: {}, rules, user, walletAttachments: [] })
    expect(result.satisfied).toBe(true)
    expect(result.missingCapabilities).toEqual([])
    expect(result.mismatchReasons).toEqual([])
  })

  test("returns missing nationality when user lacks verification", async () => {
    const user = makeUser({ nationality: { state: "unverified" } })
    const rules = [makeNationalityRule("US")]
    const result = await evaluateMembershipGateRules({ env: {}, rules, user, walletAttachments: [] })
    expect(result.satisfied).toBe(false)
    expect(result.missingCapabilities).toEqual(["nationality"])
    expect(result.suggestedVerificationProvider).toBe("self")
  })

  test("returns nationality_mismatch when verified nationality differs", async () => {
    const user = makeUser({ nationality: { state: "verified", provider: "self", value: "AR" } })
    const rules = [makeNationalityRule("US")]
    const result = await evaluateMembershipGateRules({ env: {}, rules, user, walletAttachments: [] })
    expect(result.satisfied).toBe(false)
    expect(result.missingCapabilities).toEqual([])
    expect(result.mismatchReasons).toContain("nationality_mismatch")
  })

  test("returns provider_not_accepted when provider is wrong", async () => {
    const user = makeUser({ nationality: { state: "verified", provider: "self", value: "US" } })
    const rules: CommunityGateRuleRow[] = [{
      gate_rule_id: "gr_test_wrong_provider",
      scope: "membership",
      gate_family: "identity_proof",
      gate_type: "nationality",
      proof_requirements_json: JSON.stringify([
        { proof_type: "nationality", accepted_providers: ["very"], config: { required_value: "US" } },
      ]),
      chain_namespace: null,
      gate_config_json: null,
      status: "active",
    }]
    const result = await evaluateMembershipGateRules({ env: {}, rules, user, walletAttachments: [] })
    expect(result.satisfied).toBe(false)
    expect(result.mismatchReasons).toContain("provider_not_accepted")
  })

  test("returns unsatisfied for empty rules", async () => {
    const user = makeUser({})
    const result = await evaluateMembershipGateRules({ env: {}, rules: [], user, walletAttachments: [] })
    expect(result.satisfied).toBe(false)
    expect(result.mismatchReasons).toContain("no_active_gate_rules")
  })

  test("evaluates multiple rules: one missing, one satisfied", async () => {
    const user = makeUser({
      uniqueHuman: { state: "verified", provider: "self" },
      nationality: { state: "unverified" },
    })
    const rules = [makeUniqueHumanRule(), makeNationalityRule("US")]
    const result = await evaluateMembershipGateRules({ env: {}, rules, user, walletAttachments: [] })
    expect(result.satisfied).toBe(false)
    expect(result.missingCapabilities).toContain("nationality")
    expect(result.missingCapabilities).not.toContain("unique_human")
  })

  test("satisfiesMembershipGateRules delegates to evaluateMembershipGateRules", async () => {
    const user = makeUser({ nationality: { state: "verified", provider: "self", value: "US" } })
    expect(await satisfiesMembershipGateRules({ env: {}, rules: [makeNationalityRule("US")], user, walletAttachments: [] })).toBe(true)
    expect(await satisfiesMembershipGateRules({ env: {}, rules: [makeNationalityRule("AR")], user, walletAttachments: [] })).toBe(false)
  })

  test("returns nationality_excluded when user nationality is in excluded_values", async () => {
    const rule: CommunityGateRuleRow = {
      gate_rule_id: "gr_excl",
      scope: "membership",
      gate_family: "identity_proof",
      gate_type: "nationality",
      proof_requirements_json: JSON.stringify([
        { proof_type: "nationality", accepted_providers: ["self"], config: { excluded_values: ["AR", "IR"] } },
      ]),
      chain_namespace: null,
      gate_config_json: null,
      status: "active",
    }
    const user = makeUser({ nationality: { state: "verified", provider: "self", value: "AR" } })
    const result = await evaluateMembershipGateRules({ env: {}, rules: [rule], user, walletAttachments: [] })
    expect(result.satisfied).toBe(false)
    expect(result.mismatchReasons).toContain("nationality_excluded")
  })

  test("builds nationality summary with excluded_values", () => {
    const rule: CommunityGateRuleRow = {
      gate_rule_id: "gr_excl_sum",
      scope: "membership",
      gate_family: "identity_proof",
      gate_type: "nationality",
      proof_requirements_json: JSON.stringify([
        { proof_type: "nationality", accepted_providers: ["self"], config: { required_value: "US", excluded_values: ["AR", "IR"] } },
      ]),
      chain_namespace: null,
      gate_config_json: null,
      status: "active",
    }
    const summary = buildMembershipGateSummary(rule)
    expect(summary.gate_type).toBe("nationality")
    expect(summary.required_value).toBe("US")
    expect(summary.excluded_values).toEqual(["AR", "IR"])
  })
})
