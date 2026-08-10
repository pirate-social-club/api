import type {
  RewardPayoutStatus,
  RewardSettlementStage,
} from "../../types"

export function rewardPayoutPublicStage(input: {
  coordinatorState: string | null
  status: RewardPayoutStatus
}): RewardSettlementStage {
  if (input.status === "confirmed") return "confirmed"
  if (input.status === "failed") return "failed"

  if (input.coordinatorState === "prepared") return "signed"
  if (input.coordinatorState === "broadcast") return "broadcast"
  if (
    input.coordinatorState === "reconciliation_required"
    || input.coordinatorState === "capacity_deferred"
    || input.coordinatorState === "preparation_parked"
    || input.coordinatorState === "confirmed"
    || input.coordinatorState === "replaced"
    || input.coordinatorState === "failed_onchain"
  ) {
    return "needs_review"
  }
  return "reserved"
}
