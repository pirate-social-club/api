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
let beginEffectStatus: "submitted" | "confirmed" = "confirmed"

mock.module("./settlement-effects", () => ({
  findConfirmedBuyerFundingEffectByTx: async () => priorUse,
  // Return a confirmed effect so the "allowed" paths resolve idempotently without
  // reaching on-chain verification.
  beginPurchaseSettlementEffectAttempt: async () => ({
    status: beginEffectStatus,
    metadata_json: beginEffectStatus === "confirmed" ? JSON.stringify(RECEIPT) : null,
  }),
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
  beforeEach(() => {
    priorUse = null
    beginEffectStatus = "confirmed"
  })

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

  test("rejects non-finite quote amounts before funding verification", async () => {
    beginEffectStatus = "submitted"

    await expect(confirmBuyerFundingForSettlement({
      env: {} as never,
      client: {} as never,
      communityId: "cmt_1",
      quote: {
        quote_id: "quote_nan",
        route_provider: "pirate_checkout",
        funding_mode: "routed",
        final_price_usd: Number.NaN,
        source_chain_json: JSON.stringify({ chain_namespace: "eip155", chain_id: 8453, display_name: "Base" }),
        funding_destination_address: "0x0000000000000000000000000000000000000001",
      } as never,
      purchaseId: "pur_nan",
      buyerAddress: "0x0000000000000000000000000000000000000002",
      fundingTxRef: "0xtx_nan",
      now: "2026-07-02T00:00:00.000Z",
    })).rejects.toThrow("Quote funding amount is invalid")
  })
})
