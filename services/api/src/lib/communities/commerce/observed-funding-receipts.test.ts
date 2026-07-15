import { describe, expect, mock, test } from "bun:test"

import type { Client, QueryResult } from "../../sql-client"
import {
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
})
