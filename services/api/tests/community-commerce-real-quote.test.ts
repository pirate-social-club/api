import { describe, expect, test } from "bun:test"
import {
  createWalletBoundRoutedQuote,
  type CreatePublicQuoteFn,
} from "../src/lib/communities/commerce/funding-source/real-quote"

const BUYER = "0x1111111111111111111111111111111111111111"
const LISTING = { listingId: "lst1", assetId: "ast1", title: "Concrete Jungle", priceUsd: 3 }

// Minimal public quote shaped like serializePublicQuote output (prefixed ids, cents, unix seconds).
function publicQuote(overrides?: Record<string, unknown>) {
  return {
    id: "pq_quo1",
    community: "com_cmt1",
    listing: "lst_lst1",
    asset: "asset_ast1",
    final_price_cents: 300,
    funding_mode: "routed",
    route_provider: "pirate_checkout",
    buyer_kind: "wallet",
    buyer_wallet: { chain_ref: "eip155", address: BUYER },
    expires_at: 1776556800,
    ...overrides,
  }
}

function makeFake(overrides?: Record<string, unknown>) {
  const calls: { input: Parameters<CreatePublicQuoteFn>[0] | null } = { input: null }
  const fn = (async (input: Parameters<CreatePublicQuoteFn>[0]) => {
    calls.input = input
    return publicQuote(overrides) as never
  }) as CreatePublicQuoteFn
  return { fn, calls }
}

const baseInput = {
  env: {} as never,
  communityId: "cmt1",
  communityRepository: {} as never,
  userRepository: {} as never,
  listing: LISTING,
  buyerWalletAddress: BUYER,
}

describe("createWalletBoundRoutedQuote", () => {
  test("requests a routed pirate_checkout quote for the SERVER-resolved listing, wallet-bound", async () => {
    const { fn, calls } = makeFake()
    await createWalletBoundRoutedQuote(baseInput, { createPublicCommunityPurchaseQuote: fn })

    const sent = calls.input!
    // Pin 4: body uses the server-resolved listing id, not tool args.
    expect((sent.body as { listing: string }).listing).toBe("lst_lst1")
    expect((sent.body as { route_provider: string }).route_provider).toBe("pirate_checkout")
    // Pin 3: buyer is wallet-bound to the selected EVM address (normalized).
    expect(sent.buyer.kind).toBe("wallet")
    if (sent.buyer.kind !== "wallet") throw new Error("unreachable")
    expect(sent.buyer.walletAddressNormalized).toBe(BUYER.toLowerCase())
  })

  test("maps the public quote to raw quoteId, USD price, and ISO expiry", async () => {
    const { fn } = makeFake()
    const result = await createWalletBoundRoutedQuote(baseInput, { createPublicCommunityPurchaseQuote: fn })
    expect(result).toEqual({
      quoteId: "quo1", // stripped pq_ prefix
      finalPriceUsd: 3, // 300 cents
      expiresAt: new Date(1776556800 * 1000).toISOString(),
    })
  })

  test("rejects a non-routed quote (pin 1)", async () => {
    const { fn } = makeFake({ funding_mode: "direct" })
    await expect(createWalletBoundRoutedQuote(baseInput, { createPublicCommunityPurchaseQuote: fn })).rejects.toThrow(/routed/i)
  })

  test("rejects a non-pirate_checkout quote (pin 2)", async () => {
    const { fn } = makeFake({ route_provider: "omniston" })
    await expect(createWalletBoundRoutedQuote(baseInput, { createPublicCommunityPurchaseQuote: fn })).rejects.toThrow(/pirate_checkout/i)
  })

  test("rejects a quote bound to a different wallet (pin 3)", async () => {
    const { fn } = makeFake({ buyer_wallet: { chain_ref: "eip155", address: "0x2222222222222222222222222222222222222222" } })
    await expect(createWalletBoundRoutedQuote(baseInput, { createPublicCommunityPurchaseQuote: fn })).rejects.toThrow(/wallet/i)
  })

  test("rejects a quote for a different listing (pin 4)", async () => {
    const { fn } = makeFake({ listing: "lst_someoneelse" })
    await expect(createWalletBoundRoutedQuote(baseInput, { createPublicCommunityPurchaseQuote: fn })).rejects.toThrow(/does not match/i)
  })
})
