import { getAddress } from "ethers"

import { conflictError } from "../../errors"
import { makeId } from "../../helpers"
import type { Client, QueryResultRow } from "../../sql-client"
import { requiredNumber, requiredString, rowValue, stringOrNull } from "../../sql-row"

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/

export type ObservedFundingReceipt = {
  id: string
  chainId: number
  tokenAddress: string
  txHash: string
  logIndex: number
  blockNumber: number
  blockHash: string
  senderAddress: string
  recipientAddress: string
  amountAtomic: string
  finalityStatus: "observed" | "canonical" | "orphaned"
  matchStatus: "unmatched" | "claimed" | "refund_review" | "refunded" | "ignored"
  consumerRail: string | null
  consumerId: string | null
  quoteId: string | null
}

function normalizedAddress(value: string): string {
  return getAddress(value).toLowerCase()
}

function normalizedHash(value: string, field: string): string {
  const normalized = String(value || "").trim().toLowerCase()
  if (!TX_HASH_RE.test(normalized)) throw conflictError(`${field} is invalid`)
  return normalized
}

function decode(row: QueryResultRow): ObservedFundingReceipt {
  return {
    id: requiredString(row, "observed_funding_receipt_id"),
    chainId: requiredNumber(row, "chain_id"),
    tokenAddress: requiredString(row, "token_address"),
    txHash: requiredString(row, "tx_hash"),
    logIndex: requiredNumber(row, "log_index"),
    blockNumber: requiredNumber(row, "block_number"),
    blockHash: requiredString(row, "block_hash"),
    senderAddress: requiredString(row, "sender_address"),
    recipientAddress: requiredString(row, "recipient_address"),
    amountAtomic: requiredString(row, "amount_atomic"),
    finalityStatus: requiredString(row, "finality_status") as ObservedFundingReceipt["finalityStatus"],
    matchStatus: requiredString(row, "match_status") as ObservedFundingReceipt["matchStatus"],
    consumerRail: stringOrNull(rowValue(row, "consumer_rail")),
    consumerId: stringOrNull(rowValue(row, "consumer_id")),
    quoteId: stringOrNull(rowValue(row, "quote_id")),
  }
}

const COLUMNS = `
  observed_funding_receipt_id, chain_id, token_address, tx_hash, log_index,
  block_number, block_hash, sender_address, recipient_address,
  CAST(amount_atomic AS TEXT) AS amount_atomic, finality_status, match_status,
  consumer_rail, consumer_id, quote_id
`

export async function observeFundingReceipt(input: {
  client: Client
  chainId: number
  tokenAddress: string
  txHash: string
  logIndex: number
  blockNumber: number
  blockHash: string
  senderAddress: string
  recipientAddress: string
  amountAtomic: string
  source: "indexer" | "buyer_hint" | "operator_reconcile"
  observedAt: string
}): Promise<ObservedFundingReceipt> {
  const immutable = {
    chainId: input.chainId,
    tokenAddress: normalizedAddress(input.tokenAddress),
    txHash: normalizedHash(input.txHash, "Funding transaction hash"),
    logIndex: input.logIndex,
    blockNumber: input.blockNumber,
    blockHash: normalizedHash(input.blockHash, "Funding block hash"),
    senderAddress: normalizedAddress(input.senderAddress),
    recipientAddress: normalizedAddress(input.recipientAddress),
    amountAtomic: BigInt(input.amountAtomic).toString(),
  }
  if (!Number.isSafeInteger(immutable.chainId) || immutable.chainId <= 0) throw conflictError("Funding chain id is invalid")
  if (!Number.isSafeInteger(immutable.logIndex) || immutable.logIndex < 0) throw conflictError("Funding log index is invalid")
  if (!Number.isSafeInteger(immutable.blockNumber) || immutable.blockNumber < 0) throw conflictError("Funding block number is invalid")
  if (BigInt(immutable.amountAtomic) <= 0n) throw conflictError("Funding amount is invalid")

  await input.client.execute({
    sql: `
      INSERT INTO observed_funding_receipts (
        observed_funding_receipt_id, chain_id, token_address, tx_hash, log_index,
        block_number, block_hash, sender_address, recipient_address, amount_atomic,
        observed_source, finality_status, match_status, observed_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'observed', 'unmatched', ?12, ?12)
      ON CONFLICT (chain_id, token_address, tx_hash, log_index) DO NOTHING
    `,
    args: [
      makeId("ofr"), immutable.chainId, immutable.tokenAddress, immutable.txHash,
      immutable.logIndex, immutable.blockNumber, immutable.blockHash,
      immutable.senderAddress, immutable.recipientAddress, immutable.amountAtomic,
      input.source, input.observedAt,
    ],
  })
  const result = await input.client.execute({
    sql: `SELECT ${COLUMNS} FROM observed_funding_receipts
          WHERE chain_id = ?1 AND token_address = ?2 AND tx_hash = ?3 AND log_index = ?4`,
    args: [immutable.chainId, immutable.tokenAddress, immutable.txHash, immutable.logIndex],
  })
  const receipt = result.rows[0] ? decode(result.rows[0]) : null
  if (!receipt) throw conflictError("Observed funding receipt could not be persisted")
  if (
    receipt.senderAddress !== immutable.senderAddress || receipt.recipientAddress !== immutable.recipientAddress
    || receipt.amountAtomic !== immutable.amountAtomic
  ) {
    throw conflictError("Observed funding receipt identity reused with different event data")
  }
  if (receipt.blockNumber !== immutable.blockNumber || receipt.blockHash !== immutable.blockHash) {
    const reIncluded = await input.client.execute({
      sql: `
        UPDATE observed_funding_receipts
        SET block_number = ?2, block_hash = ?3, observed_source = ?4,
            finality_status = 'observed', canonical_at = NULL,
            match_status = CASE WHEN match_status = 'ignored' THEN 'unmatched' ELSE match_status END,
            updated_at = ?5
        WHERE observed_funding_receipt_id = ?1
          AND finality_status = 'orphaned'
          AND block_number = ?6 AND block_hash = ?7
        RETURNING ${COLUMNS}
      `,
      args: [
        receipt.id, immutable.blockNumber, immutable.blockHash, input.source,
        input.observedAt, receipt.blockNumber, receipt.blockHash,
      ],
    })
    if (!reIncluded.rows[0]) {
      throw conflictError("Observed funding receipt block changed before it was orphaned")
    }
    return decode(reIncluded.rows[0])
  }
  return receipt
}

export async function setObservedFundingReceiptFinality(input: {
  client: Client
  receiptId: string
  status: "canonical" | "orphaned"
  now: string
}): Promise<ObservedFundingReceipt> {
  const result = await input.client.execute({
    sql: `
      UPDATE observed_funding_receipts
      SET finality_status = ?2,
          canonical_at = CASE WHEN ?2 = 'canonical' THEN COALESCE(canonical_at, ?3) ELSE canonical_at END,
          match_status = CASE
            WHEN ?2 = 'orphaned' AND match_status = 'claimed' THEN 'refund_review'
            WHEN ?2 = 'orphaned' AND match_status = 'unmatched' THEN 'ignored'
            ELSE match_status
          END,
          updated_at = ?3
      WHERE observed_funding_receipt_id = ?1
        AND NOT (finality_status = 'orphaned' AND ?2 = 'canonical')
      RETURNING ${COLUMNS}
    `,
    args: [input.receiptId, input.status, input.now],
  })
  if (!result.rows[0]) throw conflictError("Observed funding receipt finality transition is invalid")
  return decode(result.rows[0])
}

export async function claimObservedFundingReceipt(input: {
  client: Client
  receiptId: string
  consumerRail: string
  consumerId: string
  quoteId?: string | null
  now: string
}): Promise<ObservedFundingReceipt> {
  const result = await input.client.execute({
    sql: `
      UPDATE observed_funding_receipts
      SET match_status = 'claimed', consumer_rail = ?2, consumer_id = ?3,
          quote_id = ?4, claimed_at = COALESCE(claimed_at, ?5), updated_at = ?5
      WHERE observed_funding_receipt_id = ?1
        AND finality_status = 'canonical'
        AND (
          match_status = 'unmatched'
          OR (
            match_status = 'claimed' AND consumer_rail = ?2 AND consumer_id = ?3
            AND quote_id IS NOT DISTINCT FROM ?4
          )
        )
      RETURNING ${COLUMNS}
    `,
    args: [input.receiptId, input.consumerRail, input.consumerId, input.quoteId ?? null, input.now],
  })
  if (!result.rows[0]) throw conflictError("Observed funding receipt is not claimable")
  return decode(result.rows[0])
}

export async function claimCanonicalFundingReceipt(input: {
  client: Client
  chainId: number
  tokenAddress: string
  txHash: string
  logIndex: number
  blockNumber: number
  blockHash: string
  senderAddress: string
  recipientAddress: string
  amountAtomic: string
  consumerRail: string
  consumerId: string
  quoteId: string
  now: string
}): Promise<ObservedFundingReceipt> {
  const observed = await observeFundingReceipt({
    client: input.client,
    chainId: input.chainId,
    tokenAddress: input.tokenAddress,
    txHash: input.txHash,
    logIndex: input.logIndex,
    blockNumber: input.blockNumber,
    blockHash: input.blockHash,
    senderAddress: input.senderAddress,
    recipientAddress: input.recipientAddress,
    amountAtomic: input.amountAtomic,
    source: "buyer_hint",
    observedAt: input.now,
  })
  const canonical = observed.finalityStatus === "canonical"
    ? observed
    : await setObservedFundingReceiptFinality({
        client: input.client,
        receiptId: observed.id,
        status: "canonical",
        now: input.now,
      })
  return await claimObservedFundingReceipt({
    client: input.client,
    receiptId: canonical.id,
    consumerRail: input.consumerRail,
    consumerId: input.consumerId,
    quoteId: input.quoteId,
    now: input.now,
  })
}
