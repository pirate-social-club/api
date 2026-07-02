import { beforeEach, describe, expect, mock, test } from "bun:test"

// Regression: a buyer funding tx must be single-use across quotes. Replaying the same
// on-chain payment to settle a different quote (free paid content / operator drain)
// must be rejected before any on-chain re-verification.

const RECEIPT = {
  txRef: "0xtx",
  fromAddress: "0xfrom",
  toAddress: "0xto",
  tokenAddress: "0xtoken",
  amountAtomic: "1000000",
  chainRef: "eip155:1",
}

let priorUse: { quote_id: string } | null = null

mock.module("./settlement-effects", () => ({
  findConfirmedBuyerFundingEffectByTx: async () => priorUse,
  // Return a confirmed effect so the "allowed" paths resolve idempotently without
  // reaching on-chain verification.
  beginPurchaseSettlementEffectAttempt: async () => ({ status: "confirmed", metadata_json: JSON.stringify(RECEIPT) }),
  confirmPurchaseSettlementEffect: async () => {},
  failPurchaseSettlementEffect: async () => {},
}))

const { confirmBuyerFundingForSettlement } = await import("./funding-proof-service")

function settle(quoteId: string) {
  return confirmBuyerFundingForSettlement({
    env: {} as never,
    client: {} as never,
    communityId: "cmt_1",
    quote: { quote_id: quoteId } as never,
    purchaseId: "pur_1",
    buyerAddress: "0xbuyer",
    fundingTxRef: "0xtx",
    now: "2026-07-02T00:00:00.000Z",
  })
}

describe("confirmBuyerFundingForSettlement — funding tx single-use", () => {
  beforeEach(() => { priorUse = null })

  test("rejects a funding tx already confirmed for a DIFFERENT quote (replay)", async () => {
    priorUse = { quote_id: "quote_other" }
    await expect(settle("quote_mine")).rejects.toThrow(/already been used/)
  })

  test("allows the same quote to resolve idempotently (same tx, same quote)", async () => {
    priorUse = { quote_id: "quote_mine" }
    await expect(settle("quote_mine")).resolves.toMatchObject({ txRef: "0xtx" })
  })

  test("allows a fresh funding tx (no prior use)", async () => {
    priorUse = null
    await expect(settle("quote_mine")).resolves.toMatchObject({ txRef: "0xtx" })
  })
})
