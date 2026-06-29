import { describe, expect, test } from "bun:test"
import {
  buildPurchaseProposalToolResult,
  type ListingResolution,
  type PurchaseProposalDeps,
  type PurchaseProposalToolContext,
  type ResolvedListing,
} from "../src/lib/communities/commerce/funding-source/purchase-proposal"
import { executeCommunityAssistantTool } from "../src/lib/communities/assistant-policy/assistant-tools"

const LISTING: ResolvedListing = { listingId: "lst_reggae", assetId: "ast_reggae", title: "Concrete Jungle", priceUsd: 3 }

function makeDeps(overrides?: { resolution?: ListingResolution; walletAddress?: string | null }): PurchaseProposalDeps {
  return {
    resolveListing: async () => overrides?.resolution ?? { kind: "resolved", listing: LISTING },
    resolveBuyerWalletAddress: async () =>
      overrides?.walletAddress === undefined ? "0xbuyer" : overrides.walletAddress,
    createWalletBoundQuote: async ({ listing }) => ({
      quoteId: `quo_${listing.listingId}`,
      finalPriceUsd: listing.priceUsd,
      expiresAt: "2026-04-21T01:00:00.000Z",
    }),
    createProposedSpendIntent: async () => ({ spendIntentId: "spi_proposed" }),
  }
}

const CTX: PurchaseProposalToolContext = { env: {} as never, telegramUserId: "tg_1", userId: "usr_1", communityId: "cmt_1" }

describe("buildPurchaseProposalToolResult (constrained tool result)", () => {
  test("proposed: server-resolved fields, purchase not complete, constrained directive", async () => {
    const result = await buildPurchaseProposalToolResult({ query: "that reggae track" }, CTX, makeDeps())
    expect(result.status).toBe("proposed")
    expect(result.title).toBe("Concrete Jungle")
    expect(result.price_usd).toBe(3)
    expect(result.purchase_complete).toBe(false)
    expect(result.funds_moved).toBe(false)
    expect(String(result.assistant_directive)).toMatch(/do not claim the song was bought, paid/i)
  })

  test("no telegram identity -> unavailable (cannot bind an intent)", async () => {
    const result = await buildPurchaseProposalToolResult({ query: "x" }, { ...CTX, telegramUserId: null }, makeDeps())
    expect(result.status).toBe("unavailable")
  })

  test("empty reference -> needs_reference", async () => {
    const result = await buildPurchaseProposalToolResult({}, CTX, makeDeps())
    expect(result.status).toBe("needs_reference")
  })

  test("ambiguous -> needs_disambiguation with candidates", async () => {
    const result = await buildPurchaseProposalToolResult({ query: "x" }, CTX, makeDeps({
      resolution: { kind: "ambiguous", candidates: [{ listingId: "a", title: "A" }, { listingId: "b", title: "B" }] },
    }))
    expect(result.status).toBe("needs_disambiguation")
    expect((result.candidates as unknown[]).length).toBe(2)
  })

  test("not found -> not_found", async () => {
    const result = await buildPurchaseProposalToolResult({ query: "x" }, CTX, makeDeps({ resolution: { kind: "not_found" } }))
    expect(result.status).toBe("not_found")
  })
})

function toolCall(args: Record<string, unknown>) {
  return {
    id: "call_1",
    type: "function" as const,
    function: { name: "propose_song_purchase", arguments: JSON.stringify(args) },
  }
}

const baseExecInput = {
  audience: "private_user" as const,
  client: {} as never,
  communityId: "cmt_1",
  policy: {} as never,
  userId: "usr_1",
}

describe("propose_song_purchase dispatch in executeCommunityAssistantTool", () => {
  test("with a purchase binding -> returns the proposed tool result", async () => {
    const out = await executeCommunityAssistantTool({
      ...baseExecInput,
      toolCall: toolCall({ query: "reggae" }),
      purchaseProposal: { context: CTX, deps: makeDeps() },
    })
    expect(out.name).toBe("propose_song_purchase")
    const parsed = JSON.parse(out.content)
    expect(parsed.status).toBe("proposed")
    expect(parsed.purchase_complete).toBe(false)
  })

  test("without a purchase binding -> graceful 'not available' error result (never crashes the loop)", async () => {
    const out = await executeCommunityAssistantTool({
      ...baseExecInput,
      toolCall: toolCall({ query: "reggae" }),
      // no purchaseProposal binding
    })
    const parsed = JSON.parse(out.content)
    expect(JSON.stringify(parsed).toLowerCase()).toMatch(/not available/i)
  })
})
