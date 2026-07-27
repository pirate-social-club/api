/**
 * Classifies a rewards-vault settlement transaction from its receipt logs.
 *
 * The vault has exactly three outcomes, and the event is the proof of which
 * one occurred:
 *
 *   RewardPaid / RewardRefunded    → confirmed
 *   OperationCapacityDeferred      → non-terminal capacity deferral
 *   anything else                  → reconciliation_required
 *
 * A successful receipt is never presumed successful. `status === 1` says the
 * transaction did not revert; it says nothing about whether funds moved,
 * because a capacity deferral is also a successful transaction that transfers
 * nothing. Reading status alone would confirm a payout that never happened.
 *
 * This replaces the trace-based classifier: capacity exhaustion is now an
 * explicit event rather than a revert reason recoverable only via
 * `debug_traceTransaction`, so settlement correctness no longer depends on a
 * paid, vendor-gated debug endpoint.
 *
 * Misclassifying a deferral as a permanent failure is a double-pay hazard: a
 * replacement cashout mints a fresh effect ID and therefore a fresh operation
 * ID, which the vault's replay protection does not block.
 */

import { getAddress } from "ethers"

/** keccak256 of each event signature. Enums encode as uint8 in the signature. */
export const VAULT_EVENT_SIGNATURES = {
  operationCapacityDeferred: "OperationCapacityDeferred(bytes32,uint8,uint256)",
  rewardPaid: "RewardPaid(bytes32,address,uint256,uint64,uint256)",
  rewardRefunded: "RewardRefunded(bytes32,address,uint256,uint64,uint256)",
} as const

export const VAULT_EVENT_TOPICS = {
  operationCapacityDeferred:
    "0xae1e0a72fd393b7ff4bba590c43ad773d2a50d6d40748936293041a3e2a19529",
  rewardPaid: "0x4d76757cf249c5eba57ea3f169aecb5262a60d4ed9c072ce0253e3d5eb79a1d1",
  rewardRefunded: "0xf0c197ec213c2ea0b0c7d22123d40a03061fb253de2c94a08a79a750652d945e",
} as const

/** Matches the vault's `OperationKind` enum ordering. */
export const VAULT_OPERATION_KIND = { payout: 0n, refund: 1n } as const

export type RewardVaultSettlementKind = "payout" | "refund"

export type RewardVaultReceiptLog = {
  address: string
  topics: readonly string[]
  data?: string
  /** Required. A log that cannot be tied to this transaction is not evidence. */
  transactionHash: string
}

export type RewardVaultSettlementOutcome =
  | { disposition: "confirmed"; reason: string }
  | { disposition: "capacity_deferred"; reason: string; deferredEpoch: bigint }
  | { disposition: "reconciliation_required"; reason: string }

/** A canonical 32-byte word, as Ethereum indexed topics always are. */
const TOPIC_RE = /^0x[0-9a-fA-F]{64}$/u
/** The persisted representation of an operation id. */
const CANONICAL_OPERATION_ID_RE = /^0x[0-9a-f]{64}$/u

/** Indexed-parameter counts, so a malformed event never becomes evidence. */
const DEFERRAL_TOPIC_COUNT = 4
const SETTLEMENT_TOPIC_COUNT = 4

function reconcile(reason: string): RewardVaultSettlementOutcome {
  return { disposition: "reconciliation_required", reason }
}

function sameAddress(left: string, right: string): boolean {
  try {
    return getAddress(left) === getAddress(right)
  } catch {
    return false
  }
}

function sameHash(left: string | undefined, right: string): boolean {
  return typeof left === "string" && TOPIC_RE.test(left) && left.toLowerCase() === right.toLowerCase()
}

function isCanonicalTopic(value: string | undefined): value is string {
  return typeof value === "string" && TOPIC_RE.test(value)
}

/** Every indexed topic must be a canonical word before anything is decoded. */
function topicsAreCanonical(log: RewardVaultReceiptLog, expectedCount: number): boolean {
  if (log.topics.length !== expectedCount) return false
  return log.topics.every((topic) => isCanonicalTopic(topic))
}

/**
 * Classifies a settlement receipt.
 *
 * Every recognized outcome must come from the pinned vault, belong to the
 * transaction being reconciled, and carry the exact operation ID. Exactly one
 * recognized outcome may be present: a receipt bearing both a settlement and a
 * deferral event is contradictory and never resolves to either.
 */
export function classifyRewardVaultSettlement(input: {
  receiptStatus: number
  receiptTransactionHash: string
  logs: readonly RewardVaultReceiptLog[]
  pinnedVaultAddress: string
  /** Canonical lowercase bytes32, as persisted on the effect row. */
  operationId: string
  expectedKind: RewardVaultSettlementKind
}): RewardVaultSettlementOutcome {
  if (input.receiptStatus !== 1) {
    return reconcile("receipt did not succeed; a reverted transaction is never classified here")
  }
  if (!CANONICAL_OPERATION_ID_RE.test(input.operationId)) {
    return reconcile("operation id is not canonical lowercase bytes32")
  }
  if (!TOPIC_RE.test(input.receiptTransactionHash)) {
    return reconcile("receipt transaction hash is not canonical")
  }

  const operationId = input.operationId
  const expectedSettlementTopic =
    input.expectedKind === "payout"
      ? VAULT_EVENT_TOPICS.rewardPaid
      : VAULT_EVENT_TOPICS.rewardRefunded
  const oppositeSettlementTopic =
    input.expectedKind === "payout"
      ? VAULT_EVENT_TOPICS.rewardRefunded
      : VAULT_EVENT_TOPICS.rewardPaid
  const expectedDeferralKind =
    input.expectedKind === "payout" ? VAULT_OPERATION_KIND.payout : VAULT_OPERATION_KIND.refund

  let settlement: RewardVaultReceiptLog | null = null
  let deferral: RewardVaultReceiptLog | null = null
  let contradiction: string | null = null

  for (const log of input.logs) {
    // Only logs from the pinned vault can mean anything. Another contract may
    // legitimately emit in the same transaction; it is not evidence about ours.
    if (!sameAddress(log.address, input.pinnedVaultAddress)) continue
    // A log from an unrelated transaction in the same block proves nothing, and
    // a log that cannot be tied to a transaction at all proves less.
    if (!sameHash(log.transactionHash, input.receiptTransactionHash)) continue

    const topic0 = log.topics[0]
    if (typeof topic0 !== "string") continue
    const topic = topic0.toLowerCase()

    if (topic === oppositeSettlementTopic && sameHash(log.topics[1], operationId)) {
      contradiction = "receipt carries the opposite settlement event for this operation id"
      continue
    }

    if (topic === expectedSettlementTopic) {
      if (!sameHash(log.topics[1], operationId)) continue
      if (!topicsAreCanonical(log, SETTLEMENT_TOPIC_COUNT)) {
        contradiction = "settlement event has a malformed topic structure"
        continue
      }
      if (settlement !== null) contradiction = "receipt carries duplicate settlement events"
      settlement = log
      continue
    }

    if (topic === VAULT_EVENT_TOPICS.operationCapacityDeferred) {
      if (!sameHash(log.topics[1], operationId)) continue
      if (!topicsAreCanonical(log, DEFERRAL_TOPIC_COUNT)) {
        contradiction = "deferral event has a malformed topic structure"
        continue
      }
      // All three parameters are indexed, so the event carries no data.
      if (log.data !== undefined && log.data !== "0x") {
        contradiction = "deferral event carried unexpected data"
        continue
      }
      if (deferral !== null) contradiction = "receipt carries duplicate deferral events"
      deferral = log
    }
  }

  if (contradiction !== null) return reconcile(contradiction)
  if (settlement !== null && deferral !== null) {
    return reconcile("receipt carries both a settlement and a deferral event for this operation id")
  }

  if (settlement !== null) {
    return {
      disposition: "confirmed",
      reason: `vault emitted ${input.expectedKind === "payout" ? "RewardPaid" : "RewardRefunded"} for this operation id`,
    }
  }

  if (deferral !== null) {
    // Topic canonicality was proven above, so decoding is safe here.
    const kind = BigInt(deferral.topics[2] as string)
    const epoch = BigInt(deferral.topics[3] as string)
    if (kind !== VAULT_OPERATION_KIND.payout && kind !== VAULT_OPERATION_KIND.refund) {
      return reconcile(`deferral event carries an unknown operation kind ${kind}`)
    }
    if (kind !== expectedDeferralKind) {
      return reconcile(
        `deferral event kind ${kind} does not match the expected ${input.expectedKind}`,
      )
    }
    return {
      disposition: "capacity_deferred",
      reason: "vault deferred this operation for epoch capacity; funds did not move",
      deferredEpoch: epoch,
    }
  }

  // The dangerous default. A successful receipt with no recognized event must
  // never be read as success.
  return reconcile(
    "successful receipt carried no recognized vault event for this operation id",
  )
}

/**
 * When a deferred operation becomes eligible again.
 *
 * The vault indexes epochs as `block.timestamp / epochDuration`, so the next
 * epoch opens at `(deferredEpoch + 1) * epochDuration`. A confirmation
 * allowance and jitter are added so retries neither race the boundary nor
 * arrive together across a queue.
 *
 * This must not be replaced by the ordinary short retry timer: every deferred
 * attempt is a SUCCESSFUL on-chain no-op that consumes signer ETH, so a timer
 * loop would burn gas continuously for the remainder of an exhausted epoch.
 */
export function nextEpochRetryAtSeconds(input: {
  deferredEpoch: bigint
  epochDurationSeconds: bigint
  confirmationAllowanceSeconds: bigint
  /** Deterministic per-effect spread; caller supplies, typically from the effect id. */
  jitterSeconds: bigint
}): bigint {
  if (input.epochDurationSeconds <= 0n) throw new Error("epochDurationSeconds must be positive")
  if (input.deferredEpoch < 0n) throw new Error("deferredEpoch must not be negative")
  if (input.confirmationAllowanceSeconds < 0n || input.jitterSeconds < 0n) {
    throw new Error("confirmation allowance and jitter must not be negative")
  }
  // Offsets must land inside the IMMEDIATELY following epoch. A larger total
  // would silently skip epochs and strand the effect.
  if (input.confirmationAllowanceSeconds + input.jitterSeconds >= input.epochDurationSeconds) {
    throw new Error(
      "confirmation allowance plus jitter must be shorter than one epoch,"
        + " or the retry lands beyond the next epoch",
    )
  }
  const nextEpochStart = (input.deferredEpoch + 1n) * input.epochDurationSeconds
  return nextEpochStart + input.confirmationAllowanceSeconds + input.jitterSeconds
}
