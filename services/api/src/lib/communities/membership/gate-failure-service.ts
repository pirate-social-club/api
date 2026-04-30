import { gateFailedWithDetails } from "../../errors"
import type { JoinEligibility } from "../../../types"
import type { GatePolicyEvaluation, GateTraceNode, RequiredActionNode, RequiredActionSet } from "./gate-types"
import { buildMembershipGateSummariesFromPolicy } from "./gate-summary"

type GateSummary = ReturnType<typeof buildMembershipGateSummariesFromPolicy>[number]

export function gateFailureReasonFromPolicyEvaluation(
  evaluation: GatePolicyEvaluation,
): JoinEligibility["failure_reason"] {
  const reasons = collectTraceReasons(evaluation.trace)
  return reasons.includes("token_inventory_unavailable")
    ? "token_inventory_unavailable"
    : reasons.includes("erc721_inventory_match_required")
      ? "erc721_inventory_match_required"
      : reasons.includes("erc721_holding_required")
        ? "erc721_holding_required"
        : reasons.includes("minimum_age_mismatch")
          ? "minimum_age_mismatch"
          : reasons.includes("wallet_score_too_low")
            ? "wallet_score_too_low"
            : reasons.includes("mechanism_not_accepted")
              ? "provider_not_accepted"
              : null
}

function collectTraceReasons(trace: GateTraceNode): string[] {
  if (trace.kind === "gate") {
    return trace.reason ? [trace.reason] : []
  }
  return trace.children.flatMap(collectTraceReasons)
}

function flattenRequiredActions(actionSet: RequiredActionSet | null): RequiredActionNode[] {
  if (!actionSet) {
    return []
  }
  return actionSet.items.flatMap((item) => item.kind === "set" ? flattenRequiredActions(item) : [item])
}

function missingCapabilitiesFromRequiredActionSet(
  actionSet: RequiredActionSet | null,
): NonNullable<JoinEligibility["missing_capabilities"]> {
  const capabilities = new Set<NonNullable<JoinEligibility["missing_capabilities"]>[number]>()
  for (const item of flattenRequiredActions(actionSet)) {
    if (item.kind !== "action") {
      continue
    }
    if (
      item.capability === "minimum_age"
      || item.capability === "nationality"
      || item.capability === "gender"
      || item.capability === "unique_human"
      || item.capability === "wallet_score"
    ) {
      capabilities.add(item.capability)
    }
  }
  return [...capabilities]
}

function suggestedProviderFromRequiredActionSet(
  actionSet: RequiredActionSet | null,
): JoinEligibility["suggested_verification_provider"] {
  const action = flattenRequiredActions(actionSet).find((item) => (
    item.kind === "action"
    && (item.provider === "self" || item.provider === "very" || item.provider === "passport")
  ))
  return action?.kind === "action" && (action.provider === "self" || action.provider === "very" || action.provider === "passport")
    ? action.provider
    : null
}

export function throwUnsatisfiedMembershipGate(input: {
  evaluation: GatePolicyEvaluation
  gateSummaries: GateSummary[]
  walletScoreStatus: JoinEligibility["wallet_score_status"]
}): never {
  const gateEvaluation: NonNullable<JoinEligibility["gate_evaluation"]> = {
    passed: input.evaluation.satisfied,
    trace: input.evaluation.trace,
    required_action_set: input.evaluation.requiredActionSet,
  }
  if (input.evaluation.requiredActionSet && input.evaluation.requiredActionSet.items.length > 0) {
    throw gateFailedWithDetails("Verification is required to join this community", {
      membership_gate_summaries: input.gateSummaries,
      gate_evaluation: gateEvaluation,
      missing_capabilities: missingCapabilitiesFromRequiredActionSet(input.evaluation.requiredActionSet),
      suggested_verification_provider: suggestedProviderFromRequiredActionSet(input.evaluation.requiredActionSet),
      suggested_verification_intent: "community_join",
      failure_reason: "missing_verification",
      ...(input.walletScoreStatus ? { wallet_score_status: input.walletScoreStatus } : {}),
    })
  }
  const reasons = collectTraceReasons(input.evaluation.trace)
  if (reasons.includes("nationality_mismatch")) {
    throw gateFailedWithDetails("Your verified nationality does not satisfy this community requirement", {
      membership_gate_summaries: input.gateSummaries,
      gate_evaluation: gateEvaluation,
      failure_reason: "nationality_mismatch",
    })
  }
  if (reasons.includes("gender_mismatch")) {
    throw gateFailedWithDetails("Your verified gender does not satisfy this community requirement", {
      membership_gate_summaries: input.gateSummaries,
      gate_evaluation: gateEvaluation,
      failure_reason: "gender_mismatch",
    })
  }
  if (reasons.includes("mechanism_not_accepted")) {
    throw gateFailedWithDetails("Your verification method does not satisfy this community requirement", {
      membership_gate_summaries: input.gateSummaries,
      gate_evaluation: gateEvaluation,
      failure_reason: "provider_not_accepted",
    })
  }
  if (reasons.includes("wallet_score_too_low")) {
    throw gateFailedWithDetails("Your Passport score does not satisfy this community requirement", {
      membership_gate_summaries: input.gateSummaries,
      gate_evaluation: gateEvaluation,
      failure_reason: "wallet_score_too_low",
      ...(input.walletScoreStatus ? { wallet_score_status: input.walletScoreStatus } : {}),
    })
  }
  if (reasons.includes("minimum_age_mismatch")) {
    throw gateFailedWithDetails("Your verified age does not satisfy this community requirement", {
      membership_gate_summaries: input.gateSummaries,
      gate_evaluation: gateEvaluation,
      failure_reason: "minimum_age_mismatch",
    })
  }
  if (reasons.includes("erc721_holding_required")) {
    throw gateFailedWithDetails("A linked Ethereum wallet holding this NFT collection is required to join", {
      membership_gate_summaries: input.gateSummaries,
      gate_evaluation: gateEvaluation,
      failure_reason: "erc721_holding_required",
    })
  }
  if (reasons.includes("token_inventory_unavailable")) {
    throw gateFailedWithDetails("Collectible inventory could not be checked right now", {
      membership_gate_summaries: input.gateSummaries,
      gate_evaluation: gateEvaluation,
      failure_reason: "token_inventory_unavailable",
    })
  }
  if (reasons.includes("erc721_inventory_match_required")) {
    throw gateFailedWithDetails("A linked wallet holding the required collectible inventory is required to join", {
      membership_gate_summaries: input.gateSummaries,
      gate_evaluation: gateEvaluation,
      failure_reason: "erc721_inventory_match_required",
    })
  }
  throw gateFailedWithDetails("Community membership requirements are not satisfied", {
    membership_gate_summaries: input.gateSummaries,
    gate_evaluation: gateEvaluation,
    failure_reason: "unsupported",
  })
}
