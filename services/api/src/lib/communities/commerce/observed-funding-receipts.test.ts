import { describe, expect, mock, test } from "bun:test"

import type { Client, QueryResult } from "../../sql-client"
import {
  claimCanonicalFundingReceipt,
  claimObservedFundingReceipt,
  observeFundingReceipt,
  setObservedFundingReceiptFinality,
} from "./observed-funding-receipts"

const EVENT = {
  chainId: 84532,
  tokenAddress: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
  txHash: `0x${"11".repeat(32)}`,
  logIndex: 7,
  blockNumber: 12345,
  blockHash: `0x${"22".repeat(32)}`,
  senderAddress: "0x1111111111111111111111111111111111111111",
  recipientAddress: "0x2222222222222222222222222222222222222222",
  amountAtomic: "4990000",
  source: "buyer_hint" as const,
  observedAt: "2026-07-15T17:00:00.000Z",
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    observed_funding_receipt_id: "ofr_receipt",
    chain_id: EVENT.chainId,
    token_address: EVENT.tokenAddress.toLowerCase(),
    tx_hash: EVENT.txHash,
    log_index: EVENT.logIndex,
    block_number: EVENT.blockNumber,
    block_hash: EVENT.blockHash,
    sender_address: EVENT.senderAddress,
    recipient_address: EVENT.recipientAddress,
    amount_atomic: EVENT.amountAtomic,
    finality_status: "observed",
    match_status: "unmatched",
    consumer_rail: null,
    consumer_id: null,
    quote_id: null,
    ...overrides,
  }
}

function clientReturning(...results: QueryResult[]): Client {
  const execute = mock(async () => results.shift() ?? { rows: [] })
  return {
    execute,
    batch: mock(async () => []),
    transaction: mock(async () => { throw new Error("unused") }),
  }
}

describe("observed funding receipts", () => {
  test("normalizes and replays the same observation-shaped event", async () => {
    const client = clientReturning({ rows: [], rowsAffected: 1 }, { rows: [row()] })

    const receipt = await observeFundingReceipt({ client, ...EVENT })

    expect(receipt).toMatchObject({
      chainId: 84532,
      tokenAddress: EVENT.tokenAddress.toLowerCase(),
      txHash: EVENT.txHash,
      logIndex: 7,
      amountAtomic: "4990000",
    })
    const insert = (client.execute as ReturnType<typeof mock>).mock.calls[0]?.[0] as { args: unknown[] }
    expect(insert.args.slice(1, 5)).toEqual([
      EVENT.chainId,
      EVENT.tokenAddress.toLowerCase(),
      EVENT.txHash,
      EVENT.logIndex,
    ])
  })

  test("rejects identity reuse with different immutable event data", async () => {
    const client = clientReturning(
      { rows: [], rowsAffected: 0 },
      { rows: [row({ amount_atomic: "5000000" })] },
    )

    await expect(observeFundingReceipt({ client, ...EVENT }))
      .rejects.toThrow("Observed funding receipt identity reused with different event data")
  })

  test("re-observes an orphaned receipt at its new canonical-chain block", async () => {
    const reIncludedBlockNumber = EVENT.blockNumber + 3
    const reIncludedBlockHash = `0x${"33".repeat(32)}`
    const client = clientReturning(
      { rows: [], rowsAffected: 0 },
      { rows: [row({ finality_status: "orphaned", match_status: "ignored" })] },
      { rows: [row({
        block_number: reIncludedBlockNumber,
        block_hash: reIncludedBlockHash,
        finality_status: "observed",
        match_status: "unmatched",
      })] },
    )

    await expect(observeFundingReceipt({
      client,
      ...EVENT,
      blockNumber: reIncludedBlockNumber,
      blockHash: reIncludedBlockHash,
      source: "indexer",
      observedAt: "2026-07-15T17:04:00.000Z",
    })).resolves.toMatchObject({
      blockNumber: reIncludedBlockNumber,
      blockHash: reIncludedBlockHash,
      finalityStatus: "observed",
      matchStatus: "unmatched",
    })

    const update = (client.execute as ReturnType<typeof mock>).mock.calls[2]?.[0] as {
      sql: string
      args: unknown[]
    }
    expect(update.sql).toContain("finality_status = 'orphaned'")
    expect(update.sql).toContain("match_status = CASE WHEN match_status = 'ignored' THEN 'unmatched'")
    expect(update.args.slice(1, 4)).toEqual([reIncludedBlockNumber, reIncludedBlockHash, "indexer"])
  })

  test("rejects a block rewrite until the old inclusion is explicitly orphaned", async () => {
    const client = clientReturning(
      { rows: [], rowsAffected: 0 },
      { rows: [row({ finality_status: "canonical" })] },
      { rows: [] },
    )

    await expect(observeFundingReceipt({
      client,
      ...EVENT,
      blockNumber: EVENT.blockNumber + 1,
      blockHash: `0x${"44".repeat(32)}`,
      source: "indexer",
    })).rejects.toThrow("Observed funding receipt block changed before it was orphaned")
  })

  test("marks finality explicitly and only claims canonical receipts", async () => {
    const canonicalClient = clientReturning({
      rows: [row({ finality_status: "canonical" })],
    })
    await expect(setObservedFundingReceiptFinality({
      client: canonicalClient,
      receiptId: "ofr_receipt",
      status: "canonical",
      now: "2026-07-15T17:01:00.000Z",
    })).resolves.toMatchObject({ finalityStatus: "canonical" })

    const claimClient = clientReturning({ rows: [] })
    await expect(claimObservedFundingReceipt({
      client: claimClient,
      receiptId: "ofr_receipt",
      consumerRail: "community_purchase",
      consumerId: "quo_1",
      quoteId: "quo_1",
      now: "2026-07-15T17:02:00.000Z",
    })).rejects.toThrow("Observed funding receipt is not claimable")
  })

  test("routes an orphaned claimed receipt to refund review", async () => {
    const client = clientReturning({
      rows: [row({
        finality_status: "orphaned",
        match_status: "refund_review",
        consumer_rail: "community_purchase",
        consumer_id: "quo_1",
        quote_id: "quo_1",
      })],
    })

    await expect(setObservedFundingReceiptFinality({
      client,
      receiptId: "ofr_receipt",
      status: "orphaned",
      now: "2026-07-15T17:03:00.000Z",
    })).resolves.toMatchObject({
      finalityStatus: "orphaned",
      matchStatus: "refund_review",
    })
  })

  test("claims a canonical transfer idempotently for the same global consumer", async () => {
    const claimed = row({
      finality_status: "canonical",
      match_status: "claimed",
      consumer_rail: "community_purchase",
      consumer_id: "cmt_1:pur_1",
      quote_id: "quo_1",
    })
    const client = clientReturning(
      { rows: [], rowsAffected: 0 },
      { rows: [claimed] },
      { rows: [claimed] },
    )

    await expect(claimCanonicalFundingReceipt({
      client,
      ...EVENT,
      consumerRail: "community_purchase",
      consumerId: "cmt_1:pur_1",
      quoteId: "quo_1",
      now: "2026-07-15T17:02:00.000Z",
    })).resolves.toMatchObject({
      matchStatus: "claimed",
      consumerId: "cmt_1:pur_1",
    })
    expect(client.execute).toHaveBeenCalledTimes(3)
  })

  test("rejects a transfer already claimed by another community and rail", async () => {
    const claimedElsewhere = row({
      finality_status: "canonical",
      match_status: "claimed",
      consumer_rail: "community_purchase",
      consumer_id: "cmt_other:pur_other",
      quote_id: "quo_other",
    })
    const client = clientReturning(
      { rows: [], rowsAffected: 0 },
      { rows: [claimedElsewhere] },
      { rows: [] },
    )

    await expect(claimCanonicalFundingReceipt({
      client,
      ...EVENT,
      consumerRail: "global_handle",
      consumerId: "ghq_1",
      quoteId: "ghq_1",
      now: "2026-07-15T17:02:00.000Z",
    })).rejects.toThrow("Observed funding receipt is not claimable")
  })
})
