import type { DbExecutor } from "../../../db-helpers"
import type { ListingResolution, PurchaseReference } from "./purchase-proposal"

// Real implementations of the proposal's listing + wallet lookups, composed from the existing
// query layer (injected so the mapping logic is fixture-testable). The real binding passes the
// concrete queries: getListingRowById + getAssetRow(.display_title) for listings, and
// listActiveWalletAttachmentRows for wallets.

// --- Listing resolution: id-exact ONLY for now ---
// Fuzzy title search is a separate product/search slice. The assistant should obtain a concrete
// listing_id via the read-only board/search tools, then propose. A query reference resolves to
// nothing (creates nothing) rather than guessing.
export type ListingLookupRow = {
  listing_id: string
  asset_id: string | null
  price_usd: number
  status: string
}

export type ListingLookupDeps = {
  getListingRowById: (
    client: DbExecutor,
    communityId: string,
    listingId: string,
  ) => Promise<ListingLookupRow | null>
  getAssetDisplayTitle: (
    client: DbExecutor,
    communityId: string,
    assetId: string,
  ) => Promise<string | null>
}

export async function resolveListingForReference(
  input: { client: DbExecutor; communityId: string; reference: PurchaseReference },
  deps: ListingLookupDeps,
): Promise<ListingResolution> {
  if (input.reference.kind !== "listing_id") {
    return { kind: "not_found" }
  }
  const row = await deps.getListingRowById(input.client, input.communityId, input.reference.listingId)
  if (!row || row.status !== "active" || !row.asset_id) {
    return { kind: "not_found" }
  }
  const title = await deps.getAssetDisplayTitle(input.client, input.communityId, row.asset_id)
  return {
    kind: "resolved",
    listing: {
      listingId: row.listing_id,
      assetId: row.asset_id,
      title: title ?? row.listing_id,
      priceUsd: row.price_usd,
    },
  }
}

// --- Primary EVM wallet for a Pirate user ---
export type WalletAttachmentLookupRow = {
  chain_namespace: string
  wallet_address_display: string
  is_primary: number
}

export type WalletLookupDeps = {
  listActiveWalletAttachmentRows: (
    client: DbExecutor,
    userId: string,
  ) => Promise<WalletAttachmentLookupRow[]>
}

export async function resolvePrimaryEvmWalletAddress(
  input: { client: DbExecutor; userId: string },
  deps: WalletLookupDeps,
): Promise<string | null> {
  const rows = await deps.listActiveWalletAttachmentRows(input.client, input.userId)
  const evm = rows.filter((row) => row.chain_namespace.startsWith("eip155"))
  if (evm.length === 0) {
    return null
  }
  const primary = evm.find((row) => row.is_primary === 1) ?? evm[0]
  return primary.wallet_address_display
}
