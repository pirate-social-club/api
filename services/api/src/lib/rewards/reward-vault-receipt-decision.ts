/**
 * Decides a rewards-vault settlement receipt.
 *
 * The security property is a three-way binding:
 *
 *   durable row == verified signed calldata == settlement event
 *
 * Each field is supplied from its REAL authority, never recovered from the
 * transaction being verified. Parsing a field out of a signed transaction
 * proves what was signed; it does not prove the signed value matches policy or
 * durable state. `rewardVaultInputFromSignedEffect` decodes deadline, policy
 * version, nonce and gas from the transaction and then "verifies" them against
 * those same decoded values, so those four can never fail — this module exists
 * so the money path does not depend on that.
 *
 * Authorities:
 *   effect kind, effect id, recipient, amount   → durable coordinator row
 *   operation id                                → keccak of the exact effect id
 *   vault, signer, chain, policy version        → pinned Lit configuration
 *   nonce                                       → durable coordinator row
 *   transaction hash                            → recomputed, equal to row and receipt
 *   deadline                                    → decoded, range-validated only
 *   gas                                         → decoded, policy-validated only
 *
 * A deferral event carries no recipient or amount, so verified calldata is the
 * ONLY thing binding those for a deferral. Verification is therefore mandatory
 * before any disposition, not merely corroborating.
 */

import { Transaction } from "ethers"

import { rewardOperationId } from "./reward-operation-id"
import {
  crossCheckDeferredEpoch,
  resolveCapacityRetryAtMs,
} from "./reward-vault-capacity-retry"
import {
  classifyRewardVaultSettlement,
  type RewardVaultSettlementKind,
} from "./reward-vault-settlement-outcome"
import {
  decodeRewardVaultDeadline,
  verifySignedRewardVaultTransaction,
  type RewardVaultTransactionInput,
} from "./reward-vault-transaction"

export type RewardVaultEffectKind = "reward_cashout" | "reward_funding_refund"

/**
 * One coherent chain snapshot. The block timestamp MUST be read from the
 * receipt's own block hash — never a separately fetched latest block, which
 * would compare an event's epoch against an unrelated time.
 */
export type RewardVaultReceiptSnapshot = {
  status: number
  transactionHash: string
  blockHash: string
  blockTimestampSeconds: bigint
  logs: readonly {
    address: string
    topics: readonly string[]
    data: string
    transactionHash: string
  }[]
}

/**
 * Structured evidence for the manual audit record, so an operator reviewing a
 * disposition never has to re-derive it from a prose reason string.
 */
export type RewardVaultDecisionEvidence = {
  transactionHash: string
  blockHash: string
  operationId: string
  recipient: string
  amountAtomic: string
  policyVersion: string
  epoch: string
}

export type RewardVaultReceiptDecision =
  | { disposition: "confirmed"; reason: string; evidence: RewardVaultDecisionEvidence }
  | {
      disposition: "capacity_deferred"
      reason: string
      deferredEpoch: bigint
      retryAtMs: number
      evidence: RewardVaultDecisionEvidence
    }
  | { disposition: "reconciliation_required"; reason: string; evidence: null }

function reconcile(reason: string): RewardVaultReceiptDecision {
  return { disposition: "reconciliation_required", reason, evidence: null }
}

const SETTLEMENT_KIND: Record<RewardVaultEffectKind, RewardVaultSettlementKind> = {
  reward_cashout: "payout",
  reward_funding_refund: "refund",
}

export function decideRewardVaultReceipt(input: {
  snapshot: RewardVaultReceiptSnapshot
  durable: {
    effectKind: RewardVaultEffectKind
    effectId: string
    recipient: string
    amountAtomic: bigint
    nonce: number
    signedTx: string
    txHash: string
  }
  pinned: {
    vaultAddress: string
    signerAddress: string
    chainId: number
    policyVersion: bigint
    epochDurationSeconds: bigint
    maxFeePerGasWei: bigint
    maxPriorityFeePerGasWei: bigint
    maxGasLimit: bigint
  }
}): RewardVaultReceiptDecision {
  const { snapshot, durable, pinned } = input

  // --- Bind the receipt to the effect we believe we broadcast.
  if (snapshot.transactionHash.toLowerCase() !== durable.txHash.toLowerCase()) {
    return reconcile("receipt transaction hash does not match the durable effect")
  }

  let parsed: Transaction
  try {
    parsed = Transaction.from(durable.signedTx)
  } catch {
    return reconcile("stored signed transaction could not be parsed")
  }
  if (!parsed.hash || parsed.hash.toLowerCase() !== durable.txHash.toLowerCase()) {
    return reconcile("stored signed transaction does not hash to the durable transaction hash")
  }

  // --- Decode only what has no durable authority, and validate it against
  // policy rather than against itself.
  let deadline: bigint
  try {
    deadline = decodeRewardVaultDeadline(durable.signedTx, durable.effectKind)
  } catch (error) {
    return reconcile(
      `signed transaction calldata is not a valid ${durable.effectKind} call: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  const maxFeePerGas = parsed.maxFeePerGas ?? 0n
  const maxPriorityFeePerGas = parsed.maxPriorityFeePerGas ?? 0n
  const gasLimit = parsed.gasLimit
  if (parsed.type !== 2) return reconcile("signed transaction is not EIP-1559 (type 2)")
  if (parsed.value !== 0n) return reconcile("signed transaction transfers native value")
  if (maxFeePerGas <= 0n || maxPriorityFeePerGas <= 0n || gasLimit <= 0n) {
    return reconcile("signed transaction gas fields are not positive")
  }
  if (maxPriorityFeePerGas > maxFeePerGas) {
    return reconcile("signed transaction priority fee exceeds its max fee")
  }
  // Fees are chosen dynamically at signing time and are not persisted, so they
  // can only be bounded by the source-controlled ceilings, not matched exactly.
  if (
    maxFeePerGas > pinned.maxFeePerGasWei
    || maxPriorityFeePerGas > pinned.maxPriorityFeePerGasWei
    || gasLimit > pinned.maxGasLimit
  ) {
    return reconcile("signed transaction gas exceeds the pinned ceilings")
  }

  // --- Rebuild the expected transaction from AUTHORITIES and prove the stored
  // signed transaction encodes exactly it. Policy version comes from pinned
  // configuration and is never accepted because the transaction says so.
  const expected: RewardVaultTransactionInput = {
    effectKind: durable.effectKind,
    effectId: durable.effectId,
    recipient: durable.recipient,
    amount: durable.amountAtomic,
    deadline,
    policyVersion: pinned.policyVersion,
    vaultAddress: pinned.vaultAddress,
    signerAddress: pinned.signerAddress,
    chainId: pinned.chainId,
    nonce: durable.nonce,
    gas: { maxFeePerGas, maxPriorityFeePerGas, gasLimit },
  }
  try {
    verifySignedRewardVaultTransaction(durable.signedTx, expected)
  } catch (error) {
    return reconcile(
      `stored signed transaction failed byte-exact verification: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  // --- Only now is the receipt evidence about a transaction we have proven.
  if (snapshot.status !== 1) {
    return reconcile("vault transaction reverted; no automated classification of a failed receipt")
  }

  const outcome = classifyRewardVaultSettlement({
    receiptStatus: snapshot.status,
    receiptTransactionHash: snapshot.transactionHash,
    logs: snapshot.logs,
    pinnedVaultAddress: pinned.vaultAddress,
    operationId: rewardOperationId(durable.effectId),
    expectedKind: SETTLEMENT_KIND[durable.effectKind],
    expectedRecipient: durable.recipient,
    expectedAmount: durable.amountAtomic,
    expectedPolicyVersion: pinned.policyVersion,
  })

  const evidence = (epoch: bigint): RewardVaultDecisionEvidence => ({
    transactionHash: snapshot.transactionHash.toLowerCase(),
    blockHash: snapshot.blockHash.toLowerCase(),
    operationId: rewardOperationId(durable.effectId),
    recipient: durable.recipient,
    amountAtomic: durable.amountAtomic.toString(),
    policyVersion: pinned.policyVersion.toString(),
    epoch: epoch.toString(),
  })

  if (outcome.disposition === "confirmed") {
    return {
      disposition: "confirmed",
      reason: outcome.reason,
      evidence: evidence(outcome.settledEpoch),
    }
  }
  if (outcome.disposition === "reconciliation_required") {
    return reconcile(outcome.reason)
  }

  // --- Deferral: cross-check the event's epoch against the receipt's OWN block
  // before scheduling anything against it.
  const crossCheck = crossCheckDeferredEpoch({
    deferredEpoch: outcome.deferredEpoch,
    receiptBlockTimestampSeconds: snapshot.blockTimestampSeconds,
    epochDurationSeconds: pinned.epochDurationSeconds,
  })
  if (!crossCheck.ok) return reconcile(crossCheck.reason)

  let retryAtMs: number
  try {
    retryAtMs = resolveCapacityRetryAtMs({
      effectId: durable.effectId,
      deferredEpoch: outcome.deferredEpoch,
      epochDurationSeconds: pinned.epochDurationSeconds,
    })
  } catch (error) {
    return reconcile(
      `capacity retry time could not be computed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  return {
    disposition: "capacity_deferred",
    reason: outcome.reason,
    deferredEpoch: outcome.deferredEpoch,
    retryAtMs,
    evidence: evidence(outcome.deferredEpoch),
  }
}
