import { gateFailedWithDetails } from "../../errors"
import type { JoinEligibility } from "../../../types"
import type { MembershipGateEvaluation } from "./gate-types"
import { buildMembershipGateSummary } from "./gate-summary"

type GateSummary = ReturnType<typeof buildMembershipGateSummary>

export function gateFailureReason(
  evaluation: Pick<MembershipGateEvaluation, "mismatchReasons">,
): JoinEligibility["failure_reason"] {
  return evaluation.mismatchReasons.includes("token_inventory_unavailable")
    ? "token_inventory_unavailable"
    : evaluation.mismatchReasons.includes("erc721_inventory_match_required")
      ? "erc721_inventory_match_required"
      : evaluation.mismatchReasons.includes("erc721_holding_required")
        ? "erc721_holding_required"
        : evaluation.mismatchReasons.includes("minimum_age_mismatch")
          ? "minimum_age_mismatch"
          : evaluation.mismatchReasons.includes("wallet_score_too_low")
            ? "wallet_score_too_low"
            : evaluation.mismatchReasons.includes("mechanism_not_accepted")
              ? "provider_not_accepted"
              : null
}

export function throwUnsatisfiedMembershipGate(input: {
  evaluation: MembershipGateEvaluation
  gateSummaries: GateSummary[]
  walletScoreStatus: JoinEligibility["wallet_score_status"]
}): never {
  if (input.evaluation.missingCapabilities.length > 0) {
    throw gateFailedWithDetails("Verification is required to join this community", {
      membership_gate_summaries: input.gateSummaries,
      missing_capabilities: input.evaluation.missingCapabilities,
      suggested_verification_provider: input.evaluation.suggestedVerificationProvider,
      suggested_verification_intent: input.evaluation.suggestedVerificationProvider === "self"
        ? "community_join"
        : null,
      failure_reason: "missing_verification",
      ...(input.walletScoreStatus ? { wallet_score_status: input.walletScoreStatus } : {}),
    })
  }
  if (input.evaluation.mismatchReasons.includes("nationality_mismatch")) {
    throw gateFailedWithDetails("Your verified nationality does not satisfy this community requirement", {
      membership_gate_summaries: input.gateSummaries,
      failure_reason: "nationality_mismatch",
    })
  }
  if (input.evaluation.mismatchReasons.includes("gender_mismatch")) {
    throw gateFailedWithDetails("Your verified gender does not satisfy this community requirement", {
      membership_gate_summaries: input.gateSummaries,
      failure_reason: "gender_mismatch",
    })
  }
  if (input.evaluation.mismatchReasons.includes("mechanism_not_accepted")) {
    throw gateFailedWithDetails("Your verification method does not satisfy this community requirement", {
      membership_gate_summaries: input.gateSummaries,
      failure_reason: "provider_not_accepted",
    })
  }
  if (input.evaluation.mismatchReasons.includes("wallet_score_too_low")) {
    throw gateFailedWithDetails("Your Passport score does not satisfy this community requirement", {
      membership_gate_summaries: input.gateSummaries,
      failure_reason: "wallet_score_too_low",
      ...(input.walletScoreStatus ? { wallet_score_status: input.walletScoreStatus } : {}),
    })
  }
  if (input.evaluation.mismatchReasons.includes("minimum_age_mismatch")) {
    throw gateFailedWithDetails("Your verified age does not satisfy this community requirement", {
      membership_gate_summaries: input.gateSummaries,
      failure_reason: "minimum_age_mismatch",
    })
  }
  if (input.evaluation.mismatchReasons.includes("erc721_holding_required")) {
    throw gateFailedWithDetails("A linked Ethereum wallet holding this NFT collection is required to join", {
      membership_gate_summaries: input.gateSummaries,
      failure_reason: "erc721_holding_required",
    })
  }
  if (input.evaluation.mismatchReasons.includes("token_inventory_unavailable")) {
    throw gateFailedWithDetails("Collectible inventory could not be checked right now", {
      membership_gate_summaries: input.gateSummaries,
      failure_reason: "token_inventory_unavailable",
    })
  }
  if (input.evaluation.mismatchReasons.includes("erc721_inventory_match_required")) {
    throw gateFailedWithDetails("A linked wallet holding the required collectible inventory is required to join", {
      membership_gate_summaries: input.gateSummaries,
      failure_reason: "erc721_inventory_match_required",
    })
  }
  throw gateFailedWithDetails("Community membership requirements are not satisfied", {
    membership_gate_summaries: input.gateSummaries,
    failure_reason: "unsupported",
  })
}
