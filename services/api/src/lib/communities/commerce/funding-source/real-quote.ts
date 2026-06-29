import { walletBuyer } from "../buyer-identity"
import { badRequestError } from "../../../errors"
import type { createPublicCommunityPurchaseQuote } from "../quote-service"
import type { ResolvedListing } from "./purchase-proposal"

// The ONLY place that knows quote-service internals. It builds a wallet-bound, routed
// pirate_checkout quote for a server-resolved listing and maps the public serialized quote back
// to the minimal shape the proposal layer needs. The proposal layer never sees quote-service
// types (pin 5). createPublicCommunityPurchaseQuote is injected (type-only import → no runtime
// quote-service graph here); the binding passes the real function.
export type CreatePublicQuoteFn = typeof createPublicCommunityPurchaseQuote
type QuoteInput = Parameters<CreatePublicQuoteFn>[0]

export async function createWalletBoundRoutedQuote(
  input: {
    env: QuoteInput["env"]
    communityId: string
    communityRepository: QuoteInput["communityRepository"]
    userRepository: QuoteInput["userRepository"]
    listing: ResolvedListing
    buyerWalletAddress: string
  },
  deps: { createPublicCommunityPurchaseQuote: CreatePublicQuoteFn },
): Promise<{ quoteId: string; finalPriceUsd: number; expiresAt: string }> {
  // Wallet-bound to the selected EVM address (normalized as quote creation expects).
  const buyer = walletBuyer({ walletAddress: input.buyerWalletAddress })
  const expectedListing = `lst_${input.listing.listingId}`
  const expectedCommunity = `com_${input.communityId}`

  const quote = await deps.createPublicCommunityPurchaseQuote({
    env: input.env,
    buyer,
    communityId: input.communityId,
    // Request a routed pirate_checkout quote against the SERVER-resolved listing id (not tool args).
    body: {
      listing: expectedListing,
      funding_asset: null,
      source_chain: null,
      route_provider: "pirate_checkout",
    } as QuoteInput["body"],
    communityRepository: input.communityRepository,
    userRepository: input.userRepository,
  })

  // Pin 1 + 2: the downstream funding path REQUIRES a routed pirate_checkout quote.
  if (quote.funding_mode !== "routed") {
    throw badRequestError("Purchase quote funding_mode is not routed")
  }
  if (quote.route_provider !== "pirate_checkout") {
    throw badRequestError("Purchase quote route_provider is not pirate_checkout")
  }
  // Pin 3: buyer must be wallet-bound to the selected EVM address.
  if (quote.buyer_kind !== "wallet" || quote.buyer_wallet.address.toLowerCase() !== buyer.walletAddressNormalized) {
    throw badRequestError("Purchase quote is not bound to the selected wallet")
  }
  // Pin 4: the quote must be for the server-resolved listing/community.
  if (quote.listing !== expectedListing || quote.community !== expectedCommunity) {
    throw badRequestError("Purchase quote listing/community does not match the resolved listing")
  }

  return {
    quoteId: quote.id.replace(/^pq_/, ""),
    finalPriceUsd: quote.final_price_cents / 100,
    expiresAt: new Date(quote.expires_at * 1000).toISOString(),
  }
}
