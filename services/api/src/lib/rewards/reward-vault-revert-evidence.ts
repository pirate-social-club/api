/**
 * Proves that an exact mined rewards-vault transaction reverted specifically
 * because the epoch capacity ceiling was reached.
 *
 * Block-pinned `eth_call` is deliberately insufficient: it executes against
 * the post-state of the whole block, so later transactions can change the
 * apparent failure. Only an exact transaction trace is authoritative here.
 */

import { Transaction, getAddress } from "ethers"

import { classifyRewardVaultRevert } from "./reward-vault-revert"
import {
  rewardVaultMethod,
  verifySignedRewardVaultTransaction,
  type RewardVaultTransactionInput,
} from "./reward-vault-transaction"

/**
 * The EXACT trace options production uses. Shared with rehearsal provider
 * qualification so the capability proven at selection time is the capability
 * actually exercised: a provider can support the default opcode tracer while
 * rejecting callTracer, and would otherwise qualify while capacity
 * classification still failed.
 */
export const REWARD_VAULT_TRACE_OPTIONS = { tracer: "callTracer", timeout: "10s" } as const

export type RewardVaultTransactionTrace = {
  /** Root call target from the trace, never a nested-call target. */
  to: string | null
  reverted: boolean
  /** Raw root-call revert output. */
  output: string | null
}

/** Narrow provider surface: implementations must use debug_traceTransaction. */
export type RewardVaultTransactionTracer = {
  traceTransaction(txHash: string): Promise<RewardVaultTransactionTrace>
}

export type RewardVaultRevertEvidence = {
  disposition: "capacity_deferred" | "reconciliation_required"
  reason: string
  errorName: string | null
  evidence: {
    method: "debug_traceTransaction"
    transactionHash: string
    blockHash: string
    selector: string
    classifiedAt: string
  } | null
}

const REWARDS_OPERATOR_KIND = "rewards"
const HASH_RE = /^0x[0-9a-fA-F]{64}$/u

function reconcile(reason: string, errorName: string | null = null): RewardVaultRevertEvidence {
  return { disposition: "reconciliation_required", reason, errorName, evidence: null }
}

export async function gatherRewardVaultRevertEvidence(input: {
  pinnedVaultAddress: string
  operatorKind: string
  effectKind: string
  signedTx: string
  transactionInput: RewardVaultTransactionInput
  receiptStatus: number
  receiptTransactionHash: string
  receiptBlockHash: string
  tracer: RewardVaultTransactionTracer
  now?: () => Date
}): Promise<RewardVaultRevertEvidence> {
  if (input.operatorKind !== REWARDS_OPERATOR_KIND) {
    return reconcile("effect is not a rewards operator effect; booking semantics unchanged")
  }
  try {
    rewardVaultMethod(input.effectKind as RewardVaultTransactionInput["effectKind"])
  } catch {
    return reconcile("effect kind is not a rewards vault payout or refund")
  }
  if (input.receiptStatus !== 0) {
    return reconcile("receipt status is not 0; not a reverted transaction")
  }
  if (!HASH_RE.test(input.receiptTransactionHash) || !HASH_RE.test(input.receiptBlockHash)) {
    return reconcile("receipt carried no canonical transaction/block identity")
  }

  let parsed: Transaction
  try {
    verifySignedRewardVaultTransaction(input.signedTx, input.transactionInput)
    parsed = Transaction.from(input.signedTx)
  } catch {
    return reconcile("stored transaction failed byte-exact vault verification")
  }
  if (
    !parsed.hash
    || parsed.hash.toLowerCase() !== input.receiptTransactionHash.toLowerCase()
  ) {
    return reconcile("receipt transaction hash does not match the verified signed transaction")
  }
  if (!parsed.to || getAddress(parsed.to) !== getAddress(input.pinnedVaultAddress)) {
    return reconcile("transaction target is not the pinned rewards vault")
  }

  let trace: RewardVaultTransactionTrace
  try {
    trace = await input.tracer.traceTransaction(input.receiptTransactionHash)
  } catch {
    return reconcile("exact transaction trace was unavailable; failing closed")
  }
  if (!trace.to || getAddress(trace.to) !== getAddress(input.pinnedVaultAddress)) {
    return reconcile("trace root target is not the pinned rewards vault")
  }
  if (!trace.reverted) {
    return reconcile("trace did not report a root revert although the receipt failed")
  }

  const classification = classifyRewardVaultRevert(trace.output)
  if (classification.disposition !== "capacity_deferred" || !classification.selector) {
    return {
      disposition: "reconciliation_required",
      reason: `traced root revert was not the capacity condition: ${classification.reason}`,
      errorName: classification.errorName,
      evidence: null,
    }
  }

  return {
    disposition: "capacity_deferred",
    reason: "exact transaction trace reverted at the vault root with EpochLimitExceeded",
    errorName: classification.errorName,
    evidence: {
      method: "debug_traceTransaction",
      transactionHash: input.receiptTransactionHash.toLowerCase(),
      blockHash: input.receiptBlockHash.toLowerCase(),
      selector: classification.selector,
      classifiedAt: (input.now ?? (() => new Date()))().toISOString(),
    },
  }
}
