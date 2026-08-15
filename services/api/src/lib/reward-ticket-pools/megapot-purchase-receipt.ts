import { Interface, getAddress } from "ethers"

import { MEGAPOT_RANDOM_BUYER_ABI } from "./megapot-abi"
import type { MegapotReceiptChainReader } from "./megapot-chain-reader"

const RANDOM_BUYER = new Interface(MEGAPOT_RANDOM_BUYER_ABI)

export type MegapotPurchaseReceipt = Readonly<{
  status: number | null
  hash: string
  from: string
  to: string | null
  blockNumber: number
  blockHash: string
  logs: readonly Readonly<{
    address: string
    topics: readonly string[]
    data: string
  }>[]
}>

export type MegapotPurchaseReceiptReviewReason =
  | "transaction_hash_mismatch"
  | "transaction_reverted"
  | "purchase_target_mismatch"
  | "purchase_operator_mismatch"
  | "random_tickets_event_missing_or_ambiguous"
  | "recipient_mismatch"
  | "drawing_mismatch"
  | "ticket_count_mismatch"
  | "ticket_cost_mismatch"
  | "ticket_ids_invalid"
  | "receipt_block_reorged"
  | "ticket_owner_mismatch"
  | "ticket_drawing_mismatch"

export type MegapotPurchaseReceiptDecision =
  | Readonly<{
      disposition: "verified"
      transactionHash: string
      blockNumber: number
      blockHash: string
      drawingId: bigint
      costAtomic: bigint
      ticketIds: readonly bigint[]
    }>
  | Readonly<{
      disposition: "needs_review"
      reason: MegapotPurchaseReceiptReviewReason
    }>
  | Readonly<{
      disposition: "retry_later"
      reason: "confirmation_depth_insufficient" | "chain_evidence_unavailable"
    }>

function sameAddress(left: string | null, right: string): boolean {
  if (!left) return false
  try {
    return getAddress(left) === getAddress(right)
  } catch {
    return false
  }
}

function review(reason: MegapotPurchaseReceiptReviewReason): MegapotPurchaseReceiptDecision {
  return { disposition: "needs_review", reason }
}

function randomTicketsEvent(receipt: MegapotPurchaseReceipt, emitter: string): {
  recipient: string
  drawingId: bigint
  count: bigint
  cost: bigint
  ticketIds: bigint[]
} | null {
  const matches = receipt.logs.flatMap((log) => {
    if (!sameAddress(log.address, emitter)) return []
    try {
      const parsed = RANDOM_BUYER.parseLog({ topics: [...log.topics], data: log.data })
      if (parsed?.name !== "RandomTicketsBought") return []
      return [{
        recipient: String(parsed.args.recipient),
        drawingId: BigInt(parsed.args.drawingId),
        count: BigInt(parsed.args.count),
        cost: BigInt(parsed.args.cost),
        ticketIds: Array.from(parsed.args.ticketIds as readonly bigint[], (value) => BigInt(value)),
      }]
    } catch {
      return []
    }
  })
  return matches.length === 1 ? matches[0] ?? null : null
}

export async function verifyMegapotPurchaseReceipt(input: {
  reader: MegapotReceiptChainReader
  receipt: MegapotPurchaseReceipt
  expected: Readonly<{
    transactionHash: string
    purchaseOperatorAddress: string
    purchaseTargetAddress: string
    randomTicketBuyerAddress: string
    custodyAddress: string
    drawingId: bigint
    ticketCount: number
    totalCostAtomic: bigint
    minimumConfirmations: number
  }>
}): Promise<MegapotPurchaseReceiptDecision> {
  const { receipt, expected } = input
  if (receipt.hash.toLowerCase() !== expected.transactionHash.toLowerCase()) {
    return review("transaction_hash_mismatch")
  }
  if (receipt.status !== 1) return review("transaction_reverted")
  if (!sameAddress(receipt.to, expected.purchaseTargetAddress)) {
    return review("purchase_target_mismatch")
  }
  if (!sameAddress(receipt.from, expected.purchaseOperatorAddress)) {
    return review("purchase_operator_mismatch")
  }

  const event = randomTicketsEvent(receipt, expected.randomTicketBuyerAddress)
  if (!event) return review("random_tickets_event_missing_or_ambiguous")
  if (!sameAddress(event.recipient, expected.custodyAddress)) return review("recipient_mismatch")
  if (event.drawingId !== expected.drawingId) return review("drawing_mismatch")
  if (event.count !== BigInt(expected.ticketCount)) return review("ticket_count_mismatch")
  if (event.cost !== expected.totalCostAtomic) return review("ticket_cost_mismatch")
  if (
    event.ticketIds.length !== expected.ticketCount
    || new Set(event.ticketIds.map(String)).size !== event.ticketIds.length
    || event.ticketIds.some((ticketId) => ticketId < 0n)
  ) {
    return review("ticket_ids_invalid")
  }

  if (!Number.isSafeInteger(expected.minimumConfirmations) || expected.minimumConfirmations < 1) {
    throw new Error("Megapot minimum confirmations must be a positive safe integer")
  }

  let headBlockNumber: number
  let canonicalBlockHash: string | null
  try {
    [headBlockNumber, canonicalBlockHash] = await Promise.all([
      input.reader.getHeadBlockNumber(),
      input.reader.getCanonicalBlockHash(receipt.blockNumber),
    ])
  } catch {
    return { disposition: "retry_later", reason: "chain_evidence_unavailable" }
  }
  if (!Number.isSafeInteger(headBlockNumber) || headBlockNumber < receipt.blockNumber) {
    return { disposition: "retry_later", reason: "chain_evidence_unavailable" }
  }
  if (!canonicalBlockHash) return { disposition: "retry_later", reason: "chain_evidence_unavailable" }
  if (canonicalBlockHash.toLowerCase() !== receipt.blockHash.toLowerCase()) {
    return review("receipt_block_reorged")
  }
  const confirmationCount = headBlockNumber - receipt.blockNumber + 1
  if (confirmationCount < expected.minimumConfirmations) {
    return { disposition: "retry_later", reason: "confirmation_depth_insufficient" }
  }

  let tickets: Awaited<ReturnType<MegapotReceiptChainReader["getTicketSnapshot"]>>[]
  try {
    tickets = await Promise.all(event.ticketIds.map((ticketId) =>
      input.reader.getTicketSnapshot(ticketId, receipt.blockNumber)
    ))
  } catch {
    return { disposition: "retry_later", reason: "chain_evidence_unavailable" }
  }
  if (tickets.some((ticket) => !sameAddress(ticket.owner, expected.custodyAddress))) {
    return review("ticket_owner_mismatch")
  }
  if (tickets.some((ticket) => ticket.drawingId !== expected.drawingId)) {
    return review("ticket_drawing_mismatch")
  }

  return {
    disposition: "verified",
    transactionHash: receipt.hash.toLowerCase(),
    blockNumber: receipt.blockNumber,
    blockHash: receipt.blockHash.toLowerCase(),
    drawingId: event.drawingId,
    costAtomic: event.cost,
    ticketIds: event.ticketIds,
  }
}
