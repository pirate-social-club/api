import { describe, expect, test } from "bun:test"
import {
  PROPOSE_SONG_PURCHASE_TOOL,
  parsePurchaseReferenceFromToolArgs,
  proposeSongPurchase,
  type ListingResolution,
  type PurchaseProposalDeps,
  type ResolvedListing,
} from "../src/lib/communities/commerce/funding-source/purchase-proposal"

const LISTING: ResolvedListing = {
  listingId: "lst_reggae",
  assetId: "ast_reggae",
  title: "Concrete Jungle",
  priceUsd: 3,
}

function makeDeps(overrides?: {
  resolution?: ListingResolution
  walletAddress?: string | null
}) {
  const calls = { quote: 0, intent: 0, lastIntentInput: null as unknown }
  const deps: PurchaseProposalDeps = {
    resolveListing: async () => overrides?.resolution ?? { kind: "resolved", listing: LISTING },
    resolveBuyerWalletAddress: async () =>
      overrides?.walletAddress === undefined ? "0xbuyer" : overrides.walletAddress,
    createWalletBoundQuote: async ({ listing }) => {
      calls.quote += 1
      // The quote prices the SERVER-resolved listing; price flows from here, not the LLM.
      return { quoteId: `quo_${listing.listingId}`, finalPriceUsd: listing.priceUsd, expiresAt: "2026-04-21T01:00:00.000Z" }
    },
    createProposedSpendIntent: async (input) => {
      calls.intent += 1
      calls.lastIntentInput = input
      return { spendIntentId: "spi_proposed" }
    },
  }
  return { deps, calls }
}

const BASE_INPUT = {
  env: {} as never,
  telegramUserId: "tg_1",
  userId: "usr_1",
  communityId: "cmt_1",
  reference: { kind: "query" as const, query: "that reggae track" },
}

describe("AI purchase proposal (server-resolved, non-completing)", () => {
  test("resolves server-side and returns a proposal that never claims completion", async () => {
    const { deps } = makeDeps()
    const result = await proposeSongPurchase(BASE_INPUT, deps)

    expect(result.outcome).toBe("proposed")
    if (result.outcome !== "proposed") throw new Error("unreachable")
    // Title + price come from the resolved listing/quote, not from the LLM's "that reggae track".
    expect(result.title).toBe("Concrete Jungle")
    expect(result.priceUsd).toBe(3)
    expect(result.spendIntentId).toBe("spi_proposed")
    expect(result.fundingProvider).toBe("pirate_checkout")
    // Hard safety invariants for the assistant.
    expect(result.purchaseComplete).toBe(false)
    expect(result.fundsMoved).toBe(false)
  })

  test("binds the spend intent to the SERVER-resolved listing + created quote", async () => {
    const { deps, calls } = makeDeps()
    await proposeSongPurchase(BASE_INPUT, deps)
    expect(calls.lastIntentInput).toMatchObject({
      telegramUserId: "tg_1",
      communityId: "cmt_1",
      listing: { listingId: "lst_reggae", assetId: "ast_reggae" },
      buyerWalletAddress: "0xbuyer",
      quoteId: "quo_lst_reggae",
    })
  })

  test("ambiguous reference: returns candidates and creates NOTHING (never guesses)", async () => {
    const { deps, calls } = makeDeps({
      resolution: {
        kind: "ambiguous",
        candidates: [
          { listingId: "lst_a", title: "Take A" },
          { listingId: "lst_b", title: "Take B" },
        ],
      },
    })
    const result = await proposeSongPurchase(BASE_INPUT, deps)
    expect(result.outcome).toBe("needs_disambiguation")
    if (result.outcome !== "needs_disambiguation") throw new Error("unreachable")
    expect(result.candidates).toHaveLength(2)
    expect(calls.quote).toBe(0)
    expect(calls.intent).toBe(0)
  })

  test("not found: returns not_found and creates nothing", async () => {
    const { deps, calls } = makeDeps({ resolution: { kind: "not_found" } })
    const result = await proposeSongPurchase(BASE_INPUT, deps)
    expect(result.outcome).toBe("not_found")
    expect(calls.quote).toBe(0)
    expect(calls.intent).toBe(0)
  })

  test("no connected wallet: rejects, creates nothing", async () => {
    const { deps, calls } = makeDeps({ walletAddress: null })
    await expect(proposeSongPurchase(BASE_INPUT, deps)).rejects.toThrow(/connected wallet is required/i)
    expect(calls.quote).toBe(0)
    expect(calls.intent).toBe(0)
  })
})

describe("propose_song_purchase tool", () => {
  test("argument parsing prefers an exact listing_id, then query", () => {
    expect(parsePurchaseReferenceFromToolArgs({ listing_id: "lst_x" })).toEqual({ kind: "listing_id", listingId: "lst_x" })
    expect(parsePurchaseReferenceFromToolArgs({ query: "blue song" })).toEqual({ kind: "query", query: "blue song" })
    expect(parsePurchaseReferenceFromToolArgs({ listing_id: "lst_x", query: "blue song" })).toEqual({
      kind: "listing_id",
      listingId: "lst_x",
    })
  })

  test("argument parsing rejects an empty reference", () => {
    expect(() => parsePurchaseReferenceFromToolArgs({})).toThrow(/listing_id or a query/i)
    expect(() => parsePurchaseReferenceFromToolArgs({ query: "   " })).toThrow(/listing_id or a query/i)
  })

  test("tool definition constrains the LLM to propose, not claim completion", () => {
    expect(PROPOSE_SONG_PURCHASE_TOOL.function.name).toBe("propose_song_purchase")
    const description = PROPOSE_SONG_PURCHASE_TOOL.function.description.toLowerCase()
    expect(description).toContain("does not buy anything")
    expect(description).toMatch(/never tell the user the purchase is done|paid|unlocked/)
    const props = PROPOSE_SONG_PURCHASE_TOOL.function.parameters.properties as Record<string, unknown>
    expect(Object.keys(props).sort()).toEqual(["listing_id", "query"])
  })
})
