export type MegapotTransactionObservation =
  | "pending"
  | "confirmed"
  | "reverted"
  | "absent"

export type MegapotPurchaseRetryDecision =
  | Readonly<{ disposition: "wait" }>
  | Readonly<{ disposition: "reconcile_terminal"; outcome: "confirmed" | "reverted" }>
  | Readonly<{ disposition: "replace_same_nonce"; nonce: number }>
  | Readonly<{
      disposition: "needs_review"
      reason: "nonce_already_consumed" | "rpc_nonce_behind_reserved_nonce"
    }>

/**
 * A submitted purchase can only be retried after chain reconciliation. The
 * function deliberately has no "new nonce" result: an absent transaction may
 * only be replaced at its durable nonce, while a consumed nonce is ambiguous.
 */
export function decideMegapotPurchaseRetry(input: {
  durableNonce: number
  transaction: MegapotTransactionObservation
  latestNonce: number
  pendingNonce: number
}): MegapotPurchaseRetryDecision {
  for (const value of [input.durableNonce, input.latestNonce, input.pendingNonce]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("Megapot nonce evidence is invalid")
  }
  if (input.latestNonce > input.pendingNonce) throw new Error("Megapot nonce evidence is inconsistent")
  if (input.transaction === "pending") return { disposition: "wait" }
  if (input.transaction === "confirmed" || input.transaction === "reverted") {
    return { disposition: "reconcile_terminal", outcome: input.transaction }
  }
  if (input.pendingNonce < input.durableNonce) {
    return { disposition: "needs_review", reason: "rpc_nonce_behind_reserved_nonce" }
  }
  if (input.latestNonce > input.durableNonce || input.pendingNonce > input.durableNonce) {
    return { disposition: "needs_review", reason: "nonce_already_consumed" }
  }
  return { disposition: "replace_same_nonce", nonce: input.durableNonce }
}
