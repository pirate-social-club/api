import type { DbExecutor } from "../../db-helpers"
import type { Env } from "../../../env"
import type { UserRepository } from "../../auth/repositories"
import { eligibilityFailed, internalError } from "../../errors"
import type { Client } from "../../sql-client"
import { evaluateMembershipGatePolicy } from "../membership/gate-policy-evaluation"
import { getMembershipGatePolicy } from "../membership/gate-policy-store"
import { canAccessCommunity, getCommunityMembershipState } from "../membership/membership-state-store"
import { normalizeStoredGatePolicy } from "../membership/gate-policy-validation"
import type { GatePolicyEvaluation } from "../membership/gate-types"
import type { NamespacePolicyRow } from "./handle-policy-service"

export async function requireHandleClaimAccess(input: {
  client: DbExecutor
  communityId: string
  userId: string
}): Promise<{ isMember: boolean }> {
  const membership = await getCommunityMembershipState(input.client as Client, input.communityId, input.userId)
  const isMember = canAccessCommunity(membership)
  if (isMember) {
    return { isMember }
  }
  throw eligibilityFailed("Community membership is required to claim names")
}

export type HandleClaimEligibility = {
  satisfied: boolean
  reason: string | null
  evaluation: GatePolicyEvaluation | null
}

export async function evaluateNamespaceHandleClaimEligibility(input: {
  env: Env
  client: DbExecutor
  communityId: string
  userId: string
  userRepository: UserRepository
  policy: NamespacePolicyRow
  mode?: "preview" | "enforce"
}): Promise<HandleClaimEligibility> {
  if (input.policy.claim_gate_mode === "none") {
    return { satisfied: true, reason: null, evaluation: null }
  }
  const gatePolicy = input.policy.claim_gate_mode === "inherit_community"
    ? await getMembershipGatePolicy(input.client as Client, input.communityId)
    : parseExplicitClaimGatePolicy(input.policy)
  if (!gatePolicy) {
    return {
      satisfied: false,
      reason: input.policy.claim_gate_mode === "inherit_community"
        ? "The community membership gate is not configured"
        : "The namespace claim gate is not configured",
      evaluation: null,
    }
  }
  const user = await input.userRepository.getUserById(input.userId)
  if (!user) throw internalError("Resolved user row is missing for handle eligibility")
  const evaluation = await evaluateMembershipGatePolicy({
    env: input.env,
    policy: gatePolicy,
    user,
    walletAttachments: await input.userRepository.getWalletAttachmentsByUserId(input.userId),
    mode: input.mode ?? "preview",
  })
  return {
    satisfied: evaluation.satisfied,
    reason: evaluation.satisfied
      ? null
      : evaluation.outcome === "provider_unavailable"
        ? "A namespace eligibility provider is temporarily unavailable"
        : "Namespace eligibility requirements are not satisfied",
    evaluation,
  }
}

export async function requireNamespaceHandleClaimEligibility(
  input: Parameters<typeof evaluateNamespaceHandleClaimEligibility>[0],
): Promise<void> {
  const eligibility = await evaluateNamespaceHandleClaimEligibility({ ...input, mode: "enforce" })
  if (!eligibility.satisfied) {
    throw eligibilityFailed(eligibility.reason ?? "Namespace eligibility requirements are not satisfied", {
      claim_gate_mode: input.policy.claim_gate_mode,
      gate_evaluation: eligibility.evaluation,
    })
  }
}

function parseExplicitClaimGatePolicy(policy: NamespacePolicyRow) {
  if (!policy.claim_gate_expression_json?.trim()) return null
  try {
    return normalizeStoredGatePolicy(JSON.parse(policy.claim_gate_expression_json))
  } catch {
    throw internalError("Community handle claim gate expression is malformed")
  }
}
