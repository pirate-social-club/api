export type TransactionEvidence = {
  hash: string
  receipt: { status: number | null; blockNumber: number | null; blockHash: string | null } | null
  transaction: { from: string; nonce: number; blockNumber: number | null } | null
}

export type StuckSettlementClassification =
  | "ambiguous_no_transaction_reference"
  | "invalid_transaction_reference"
  | "chain_confirmed_local_stuck"
  | "chain_reverted_local_stuck"
  | "chain_pending"
  | "chain_transaction_not_found"

const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/

export function selectSettlementTransactionHash(input: {
  settlementRef: string | null
  providerReceiptRef: string | null
}): string | null {
  for (const candidate of [input.providerReceiptRef, input.settlementRef]) {
    const normalized = candidate?.trim() ?? ""
    if (normalized) return normalized
  }
  return null
}

export function isTransactionHash(value: string): boolean {
  return TX_HASH_PATTERN.test(value)
}

export function classifyStuckSettlementEffect(input: {
  transactionHash: string | null
  evidence?: TransactionEvidence
}): StuckSettlementClassification {
  if (!input.transactionHash) return "ambiguous_no_transaction_reference"
  if (!isTransactionHash(input.transactionHash)) return "invalid_transaction_reference"
  if (input.evidence?.receipt?.status === 1) return "chain_confirmed_local_stuck"
  if (input.evidence?.receipt?.status === 0) return "chain_reverted_local_stuck"
  if (input.evidence?.transaction) return "chain_pending"
  return "chain_transaction_not_found"
}
