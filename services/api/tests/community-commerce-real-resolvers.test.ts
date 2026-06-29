import { describe, expect, test } from "bun:test"
import {
  resolveListingForReference,
  resolvePrimaryEvmWalletAddress,
  type ListingLookupDeps,
  type ListingLookupRow,
  type WalletLookupDeps,
} from "../src/lib/communities/commerce/funding-source/real-resolvers"

const ACTIVE_LISTING: ListingLookupRow = {
  listing_id: "lst_1",
  asset_id: "ast_1",
  price_usd: 3,
  status: "active",
}

function listingDeps(overrides?: {
  row?: ListingLookupRow | null
  title?: string | null
}): { deps: ListingLookupDeps; calls: { getListingById: number; getTitle: number } } {
  const calls = { getListingById: 0, getTitle: 0 }
  return {
    calls,
    deps: {
      getListingRowById: async () => {
        calls.getListingById += 1
        return overrides?.row === undefined ? ACTIVE_LISTING : overrides.row
      },
      getAssetDisplayTitle: async () => {
        calls.getTitle += 1
        return overrides?.title === undefined ? "Concrete Jungle" : overrides.title
      },
    },
  }
}

describe("resolveListingForReference (id-exact only)", () => {
  test("an active listing resolves with title (from the asset) and price", async () => {
    const { deps } = listingDeps()
    const result = await resolveListingForReference(
      { client: {} as never, communityId: "cmt_1", reference: { kind: "listing_id", listingId: "lst_1" } },
      deps,
    )
    expect(result).toEqual({
      kind: "resolved",
      listing: { listingId: "lst_1", assetId: "ast_1", title: "Concrete Jungle", priceUsd: 3 },
    })
  })

  test("a query reference resolves to nothing (fuzzy search not enabled), never looks up", async () => {
    const { deps, calls } = listingDeps()
    const result = await resolveListingForReference(
      { client: {} as never, communityId: "cmt_1", reference: { kind: "query", query: "reggae" } },
      deps,
    )
    expect(result.kind).toBe("not_found")
    expect(calls.getListingById).toBe(0)
  })

  test("missing / inactive / asset-less listings resolve to not_found", async () => {
    for (const row of [null, { ...ACTIVE_LISTING, status: "archived" }, { ...ACTIVE_LISTING, asset_id: null }]) {
      const { deps } = listingDeps({ row })
      const result = await resolveListingForReference(
        { client: {} as never, communityId: "cmt_1", reference: { kind: "listing_id", listingId: "lst_1" } },
        deps,
      )
      expect(result.kind).toBe("not_found")
    }
  })

  test("falls back to the listing id as the title when the asset has none", async () => {
    const { deps } = listingDeps({ title: null })
    const result = await resolveListingForReference(
      { client: {} as never, communityId: "cmt_1", reference: { kind: "listing_id", listingId: "lst_1" } },
      deps,
    )
    if (result.kind !== "resolved") throw new Error("unreachable")
    expect(result.listing.title).toBe("lst_1")
  })
})

function walletDeps(rows: Array<{ chain_namespace: string; wallet_address_display: string; is_primary: number }>): WalletLookupDeps {
  return { listActiveWalletAttachmentRows: async () => rows }
}

describe("resolvePrimaryEvmWalletAddress", () => {
  test("picks the primary eip155 wallet", async () => {
    const addr = await resolvePrimaryEvmWalletAddress(
      { client: {} as never, userId: "usr_1" },
      walletDeps([
        { chain_namespace: "eip155", wallet_address_display: "0xSecondary", is_primary: 0 },
        { chain_namespace: "eip155", wallet_address_display: "0xPrimary", is_primary: 1 },
      ]),
    )
    expect(addr).toBe("0xPrimary")
  })

  test("falls back to the first eip155 wallet when none is flagged primary", async () => {
    const addr = await resolvePrimaryEvmWalletAddress(
      { client: {} as never, userId: "usr_1" },
      walletDeps([{ chain_namespace: "eip155", wallet_address_display: "0xOnly", is_primary: 0 }]),
    )
    expect(addr).toBe("0xOnly")
  })

  test("ignores non-eip155 wallets; returns null when there is no EVM wallet", async () => {
    const addr = await resolvePrimaryEvmWalletAddress(
      { client: {} as never, userId: "usr_1" },
      walletDeps([{ chain_namespace: "ton", wallet_address_display: "EQton", is_primary: 1 }]),
    )
    expect(addr).toBeNull()
  })
})
