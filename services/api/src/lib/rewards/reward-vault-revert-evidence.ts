/**
 * Gathers proof that a reverted rewards-vault transaction failed *specifically*
 * because the epoch capacity ceiling was reached.
 *
 * Nothing here trusts a receipt, an RPC error message, or a local capacity
 * estimate. The only accepted evidence is the revert data produced by replaying
 * the exact mined transaction against the exact block it was mined in.
 *
 * Every gate fails closed to `reconciliation_required`. Deferral is granted only
 * when all of them pass, because a wrong deferral spins forever and a wrong
 * `failed_onchain` pays the reward twice.
 *
 * Scope: rewards vault effects only. Booking failure semantics are deliberately
 * untouched — this must not alter a settled money path as a side effect.
 */

import { Transaction, getAddress } from "ethers"

import { classifyRewardVaultRevert } from "./reward-vault-revert"
import {
  rewardVaultMethod,
  verifySignedRewardVaultTransaction,
  type RewardVaultTransactionInput,
} from "./reward-vault-transaction"

/**
 * Narrow replay surface. Intentionally not an ethers `Provider`: the only
 * capability this module may exercise is a block-pinned `eth_call`.
 */
export type RewardVaultRevertReplayer = {
  /**
   * Replays a call at an explicit historical block. Must reject rather than
   * silently fall back to `latest` when the block is unavailable.
   *
   * Returns raw revert data on revert, or null when the call unexpectedly
   * succeeded.
   */
  callAtBlock(
    call: { to: string; from: string; data: string; value: bigint },
    blockNumber: number,
  ): Promise<{ reverted: true; data: string | null } | { reverted: false }>
}

export type RewardVaultRevertEvidence = {
  disposition: "capacity_deferred" | "reconciliation_required"
  reason: string
  errorName: string | null
  replayedAtBlock: number | null
}

const REWARDS_OPERATOR_KIND = "rewards"

function reconcile(reason: string, errorName: string | null = null): RewardVaultRevertEvidence {
  return { disposition: "reconciliation_required", reason, errorName, replayedAtBlock: null }
}

export async function gatherRewardVaultRevertEvidence(input: {
  /** Resolved by the caller from config; kept out of here so this stays pure. */
  pinnedVaultAddress: string
  operatorKind: string
  effectKind: string
  /** The exact signed transaction that was broadcast and mined. */
  signedTx: string
  /** The canonical request this effect was signed for; re-verified here. */
  transactionInput: RewardVaultTransactionInput
  receiptStatus: number
  receiptBlockNumber: number | null
  replayer: RewardVaultRevertReplayer
}): Promise<RewardVaultRevertEvidence> {
  // Gate 1 — rewards vault effects only. Bookings keep their existing semantics.
  if (input.operatorKind !== REWARDS_OPERATOR_KIND) {
    return reconcile("effect is not a rewards operator effect; booking semantics unchanged")
  }
  try {
    rewardVaultMethod(input.effectKind as RewardVaultTransactionInput["effectKind"])
  } catch {
    return reconcile("effect kind is not a rewards vault payout or refund")
  }

  // Gate 2 — receipt must actually be a revert. Anything else is not our case.
  if (input.receiptStatus !== 0) {
    return reconcile("receipt status is not 0; not a reverted transaction")
  }
  if (input.receiptBlockNumber === null || !Number.isSafeInteger(input.receiptBlockNumber)) {
    return reconcile("receipt carried no usable block number; cannot pin replay")
  }

  // Gate 3 — the stored transaction must still pass the byte-exact verifier.
  // If it does not, we do not know what was actually broadcast, so no revert
  // classification of it can be trusted.
  let parsed: Transaction
  try {
    verifySignedRewardVaultTransaction(input.signedTx, input.transactionInput)
    parsed = Transaction.from(input.signedTx)
  } catch {
    return reconcile("stored transaction failed byte-exact vault verification")
  }

  // Gate 4 — the call target must still be the pinned vault.
  if (!parsed.to || getAddress(parsed.to) !== getAddress(input.pinnedVaultAddress)) {
    return reconcile("transaction target is not the pinned rewards vault")
  }
  if (!parsed.from) {
    return reconcile("transaction carried no recoverable sender")
  }

  // Gate 5 — replay the exact transaction against the exact block it was mined
  // in. Archive availability is fallible; a failure here must never degrade to
  // `latest`, where a rolled epoch or changed policy would misclassify the
  // original failure.
  let replay: Awaited<ReturnType<RewardVaultRevertReplayer["callAtBlock"]>>
  try {
    replay = await input.replayer.callAtBlock(
      {
        to: getAddress(parsed.to),
        from: getAddress(parsed.from),
        data: parsed.data,
        value: parsed.value,
      },
      input.receiptBlockNumber,
    )
  } catch {
    return reconcile("historical replay was unavailable at the receipt block; failing closed")
  }

  if (!replay.reverted) {
    return reconcile("replay did not revert although the mined receipt failed; evidence inconsistent")
  }

  // Gate 6 — the selector must be exactly the capacity error. Unknown, absent
  // and malformed data all fail closed inside the classifier.
  const classification = classifyRewardVaultRevert(replay.data)
  if (classification.disposition !== "capacity_deferred") {
    return {
      disposition: "reconciliation_required",
      reason: `replayed revert was not the capacity condition: ${classification.reason}`,
      errorName: classification.errorName,
      replayedAtBlock: input.receiptBlockNumber,
    }
  }

  return {
    disposition: "capacity_deferred",
    reason:
      "replay at the receipt block reverted with EpochLimitExceeded; operation is unchanged"
      + " and retryable once the epoch rolls",
    errorName: classification.errorName,
    replayedAtBlock: input.receiptBlockNumber,
  }
}
