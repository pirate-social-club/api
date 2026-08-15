import { describe, expect, test } from "bun:test"
import { Interface } from "ethers"

import { MEGAPOT_RANDOM_BUYER_ABI } from "./megapot-abi"
import type { MegapotReceiptChainReader } from "./megapot-chain-reader"
import {
  type MegapotPurchaseReceipt,
  verifyMegapotPurchaseReceipt,
} from "./megapot-purchase-receipt"

const BUYER = "0x4000000000000000000000000000000000000004"
const OPERATOR = "0x2000000000000000000000000000000000000002"
const CUSTODY = "0x1000000000000000000000000000000000000001"
const ESCROW = "0x6000000000000000000000000000000000000006"
const TX_HASH = `0x${"a".repeat(64)}`
const BLOCK_HASH = `0x${"b".repeat(64)}`

function eventLog(input: {
  recipient?: string
  drawingId?: bigint
  count?: bigint
  cost?: bigint
  ticketIds?: readonly bigint[]
} = {}): MegapotPurchaseReceipt["logs"][number] {
  const iface = new Interface(MEGAPOT_RANDOM_BUYER_ABI)
  const event = iface.getEvent("RandomTicketsBought")
  if (!event) throw new Error("RandomTicketsBought ABI missing")
  const encoded = iface.encodeEventLog(event, [
    input.recipient ?? CUSTODY,
    input.drawingId ?? 7n,
    input.count ?? 2n,
    input.cost ?? 20_000n,
    input.ticketIds ?? [90n, 91n],
  ])
  return { address: BUYER, topics: encoded.topics, data: encoded.data }
}

function receipt(log = eventLog()): MegapotPurchaseReceipt {
  return {
    status: 1,
    hash: TX_HASH,
    from: OPERATOR,
    to: ESCROW,
    blockNumber: 100,
    blockHash: BLOCK_HASH,
    logs: [log],
  }
}

function reader(overrides: Partial<MegapotReceiptChainReader> = {}): MegapotReceiptChainReader {
  return {
    getHeadBlockNumber: async () => 110,
    getCanonicalBlockHash: async () => BLOCK_HASH,
    getTicketSnapshot: async () => ({ owner: CUSTODY, drawingId: 7n }),
    ...overrides,
  }
}

const expected = {
  transactionHash: TX_HASH,
  purchaseOperatorAddress: OPERATOR,
  purchaseTargetAddress: ESCROW,
  randomTicketBuyerAddress: BUYER,
  custodyAddress: CUSTODY,
  drawingId: 7n,
  ticketCount: 2,
  totalCostAtomic: 20_000n,
  minimumConfirmations: 5,
}

describe("Megapot purchase receipt verification", () => {
  test("binds the receipt, event, custody ownership, per-ticket drawing, finality, and canonical block", async () => {
    expect(await verifyMegapotPurchaseReceipt({ reader: reader(), receipt: receipt(), expected }))
      .toEqual({
        disposition: "verified",
        transactionHash: TX_HASH,
        blockNumber: 100,
        blockHash: BLOCK_HASH,
        drawingId: 7n,
        costAtomic: 20_000n,
        ticketIds: [90n, 91n],
      })
  })

  test("quarantines a boundary-straddled event and a mismatched per-ticket drawing", async () => {
    expect(await verifyMegapotPurchaseReceipt({
      reader: reader(),
      receipt: receipt(eventLog({ drawingId: 8n })),
      expected,
    })).toEqual({ disposition: "needs_review", reason: "drawing_mismatch" })

    expect(await verifyMegapotPurchaseReceipt({
      reader: reader({ getTicketSnapshot: async () => ({ owner: CUSTODY, drawingId: 8n }) }),
      receipt: receipt(),
      expected,
    })).toEqual({ disposition: "needs_review", reason: "ticket_drawing_mismatch" })
  })

  test("waits for finality and quarantines a replaced canonical block", async () => {
    expect(await verifyMegapotPurchaseReceipt({
      reader: reader({ getHeadBlockNumber: async () => 102 }),
      receipt: receipt(),
      expected,
    })).toEqual({ disposition: "retry_later", reason: "confirmation_depth_insufficient" })
    expect(await verifyMegapotPurchaseReceipt({
      reader: reader({ getCanonicalBlockHash: async () => `0x${"c".repeat(64)}` }),
      receipt: receipt(),
      expected,
    })).toEqual({ disposition: "needs_review", reason: "receipt_block_reorged" })
  })
})
