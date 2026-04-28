import type { Env, User, WalletAttachmentSummary } from "../../../types"
import {
  parseGateConfig,
  parseProofRequirements,
} from "./gate-config"
import { evaluateIdentityProofRequirement } from "./identity-gate-evaluation"
import { evaluateTokenGateRule } from "./token-gate-evaluation"
export type {
  CommunityGateRuleRow,
  MembershipGateEvaluation,
} from "./gate-types"
import type {
  CommunityGateRuleRow,
  MembershipGateEvaluation,
  SuggestedVerificationProvider,
} from "./gate-types"
export { toCommunityGateRuleRow } from "./gate-row"
export { buildMembershipGateSummary } from "./gate-summary"

export async function satisfiesMembershipGateRules(input: {
  env: Env
  rules: CommunityGateRuleRow[]
  user: User
  walletAttachments: WalletAttachmentSummary[]
}): Promise<boolean> {
  return (await evaluateMembershipGateRules(input)).satisfied
}

export async function evaluateMembershipGateRules(input: {
  env: Env
  rules: CommunityGateRuleRow[]
  user: User
  walletAttachments: WalletAttachmentSummary[]
}): Promise<MembershipGateEvaluation> {
  const { env, rules, user, walletAttachments } = input
  if (rules.length === 0) {
    return {
      satisfied: false,
      missingCapabilities: [],
      mismatchReasons: ["no_active_gate_rules"],
      suggestedVerificationProvider: null,
    }
  }

  const missingCapabilities: MembershipGateEvaluation["missingCapabilities"] = []
  const mismatchReasons: string[] = []
  let suggestedProvider: SuggestedVerificationProvider | null = null

  for (const rule of rules) {
    if (rule.gate_family === "token_holding") {
      await evaluateTokenGateRule({
        env,
        rule,
        walletAttachments,
        mismatchReasons,
      })
      continue
    }
    if (rule.gate_family !== "identity_proof") {
      mismatchReasons.push(`unsupported_gate_family:${rule.gate_family}`)
      continue
    }

    const gateConfig = parseGateConfig(rule.gate_config_json)
    const requirements = parseProofRequirements(rule.proof_requirements_json, rule.gate_type)

    for (const requirement of requirements) {
      suggestedProvider = evaluateIdentityProofRequirement({
        user,
        requirement,
        gateConfig,
        missingCapabilities,
        mismatchReasons,
        suggestedProvider,
      })
    }
  }

  return {
    satisfied: missingCapabilities.length === 0 && mismatchReasons.length === 0,
    missingCapabilities,
    mismatchReasons,
    suggestedVerificationProvider: suggestedProvider,
  }
}
