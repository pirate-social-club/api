import {
  buildRewardTicketMegapotPurchasePlan,
  type RewardTicketMegapotPurchasePlan,
} from "./reward-ticket-megapot-purchase"
import {
  evaluateRewardTicketDrawingAssociation,
  type RewardTicketDrawingAssociation,
} from "./reward-ticket-drawing-guard"
import type { RewardTicketPoolConfig } from "./reward-ticket-pool-config"

export type RewardTicketPurchaseWorkerResult =
  | {
      status: "confirmed"
      txHash: string
      drawingId: string
      plan: RewardTicketMegapotPurchasePlan
    }
  | {
      status: "failed"
      reason: "submission_failed" | "transaction_reverted"
      txHash?: string
      plan: RewardTicketMegapotPurchasePlan
    }
  | {
      status: "needs_review"
      reason: "drawing_rolled_over" | "receipt_drawing_id_mismatch" | "receipt_unavailable"
      txHash?: string
      drawingCheck?: RewardTicketDrawingAssociation
      plan: RewardTicketMegapotPurchasePlan
    }

export type RewardTicketPurchaseWorkerDependencies = {
  readCurrentDrawingId: () => Promise<string | bigint>
  submitPurchase: (plan: RewardTicketMegapotPurchasePlan) => Promise<{ txHash: string }>
  readReceipt: (txHash: string) => Promise<{
    status: 0 | 1
    drawingId: string | bigint | null
  } | null>
}

/**
 * Execute only the chain-facing half of a reserved purchase. Database state
 * transitions are deliberately owned by the caller/reconciler: a submission
 * with no receipt is ambiguous and therefore never gets silently released.
 */
export async function executeRewardTicketPurchase(input: {
  config: Pick<RewardTicketPoolConfig, "randomTicketBuyerAddress" | "custodyAddress" | "referrerAddress" | "sourceTag">
  expectedDrawingId: string | bigint
  ticketCount: number
  dependencies: RewardTicketPurchaseWorkerDependencies
}): Promise<RewardTicketPurchaseWorkerResult> {
  const plan = buildRewardTicketMegapotPurchasePlan({
    config: input.config,
    ticketCount: input.ticketCount,
    expectedDrawingId: input.expectedDrawingId,
  })

  const currentDrawingId = await input.dependencies.readCurrentDrawingId()
  const beforeSubmit = evaluateRewardTicketDrawingAssociation({
    expectedDrawingId: input.expectedDrawingId,
    observedDrawingId: currentDrawingId,
    stage: "before_submit",
  })
  if (beforeSubmit.status === "needs_review") {
    return {
      status: "needs_review",
      reason: "drawing_rolled_over",
      drawingCheck: beforeSubmit,
      plan,
    }
  }

  let txHash: string
  try {
    txHash = (await input.dependencies.submitPurchase(plan)).txHash
  } catch {
    return { status: "failed", reason: "submission_failed", plan }
  }
  if (!/^0x[0-9a-fA-F]{64}$/u.test(txHash)) {
    return { status: "needs_review", reason: "receipt_unavailable", txHash, plan }
  }

  const receipt = await input.dependencies.readReceipt(txHash)
  if (!receipt) return { status: "needs_review", reason: "receipt_unavailable", txHash, plan }
  if (receipt.status !== 1) return { status: "failed", reason: "transaction_reverted", txHash, plan }
  if (receipt.drawingId == null) {
    return { status: "needs_review", reason: "receipt_unavailable", txHash, plan }
  }

  const receiptCheck = evaluateRewardTicketDrawingAssociation({
    expectedDrawingId: input.expectedDrawingId,
    observedDrawingId: receipt.drawingId,
    stage: "receipt",
  })
  if (receiptCheck.status === "needs_review") {
    return {
      status: "needs_review",
      reason: "receipt_drawing_id_mismatch",
      txHash,
      drawingCheck: receiptCheck,
      plan,
    }
  }
  return { status: "confirmed", txHash, drawingId: receiptCheck.drawingId, plan }
}
