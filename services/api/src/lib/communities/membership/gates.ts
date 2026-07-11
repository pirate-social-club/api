import type { Env } from "../../../env"
import type { User, WalletAttachmentSummary } from "../../../types"
import { evaluateMembershipGatePolicy } from "./gate-policy-evaluation"
import { evaluateIdentityGateRule } from "./identity-gate-evaluation"
import { evaluateTokenGateRule } from "./token-gate-evaluation"
import type {
  CommunityGateRuleRow,
  GatePolicy,
  MembershipGateEvaluation,
  SuggestedVerificationProvider,
} from "./gate-types"

export {
  buildMembershipGateExpressionFromPolicy,
  buildMembershipGateSummariesFromPolicy,
  buildMembershipGateSummary,
  flattenGatePolicyAtoms,
  getGatePolicyMatchMode,
} from "./gate-summary"
export { evaluateMembershipGatePolicy }
export type {
  CommunityGateRuleRow,
  MembershipGateEvaluation,
} from "./gate-types"

export async function satisfiesMembershipGatePolicy(input: {
  env: Env
  policy: GatePolicy | null
  user: User
  walletAttachments: WalletAttachmentSummary[]
}): Promise<boolean> {
  return (await evaluateMembershipGatePolicy(input)).satisfied
}

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
      mismatchReasons.push(...await evaluateTokenGateRule({ env, rule, walletAttachments }))
      continue
    }
    if (rule.gate_family !== "identity_proof") {
      mismatchReasons.push(`unsupported_gate_family:${rule.gate_family}`)
      continue
    }

    const result = evaluateIdentityGateRule({ rule, user, suggestedProvider })
    missingCapabilities.push(...result.missingCapabilities)
    mismatchReasons.push(...result.mismatchReasons)
    suggestedProvider = result.suggestedVerificationProvider
  }

  return {
    satisfied: missingCapabilities.length === 0 && mismatchReasons.length === 0,
    missingCapabilities,
    mismatchReasons,
    suggestedVerificationProvider: suggestedProvider,
  }
}
