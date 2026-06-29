// Funding-source acquisition boundary.
//
// Invariant: all purchases settle from one canonical buyer-funding boundary — a confirmed
// Base/Base-Sepolia USDC transfer into the checkout recipient. Funding *sources* (pirate
// checkout today, Omniston/TON later) differ only in how that Base USDC tx comes to exist.
//
// A provider therefore never produces a trusted receipt. Its confirmed result carries only a
// `baseUsdcTxRef`; the canonical BuyerFundingReceipt is still derived by on-chain verification
// of that tx (see verifyBaseUsdcFundingReceipt). Omniston is on the *discovery* path, never the
// *trust* path.

// ton_testnet_transfer is a DEV-ONLY provider: it proves the Telegram Wallet / TON Connect
// approval + bot UX loop against TON testnet. It deliberately does NOT pretend to be Omniston and
// is never a canonical funding receipt — real funding is still confirmed only from a Base USDC
// txRef. It is selectable only when explicitly enabled in dev/test.
export type FundingSourceProviderId = "pirate_checkout" | "omniston_ton" | "ton_testnet_transfer"

// Opaque correlation breadcrumbs. Persisted for audit/refund reconciliation, never trusted as
// proof of settlement. `sourceTxRef` is the originating leg (e.g. a TON tx / message hash);
// `baseUsdcTxRef` is the discovered Base USDC tx (present only once confirmed).
export type FundingSourceCorrelation = {
  kind: "evm_direct" | "omniston_ton" | "ton_testnet"
  sourceTxRef?: string | null
  routeRef?: string | null
  baseUsdcTxRef?: string | null
}

// Acquisition state only — deliberately NOT a BuyerFundingReceipt. The confirmed variant
// exposes a Base USDC tx hash; downstream verification turns that into the canonical receipt.
export type FundingAcquisition =
  | { status: "confirmed"; baseUsdcTxRef: string; sourceCorrelation: FundingSourceCorrelation }
  | { status: "pending"; retryAfterMs?: number; sourceCorrelation?: FundingSourceCorrelation }
  | { status: "failed"; reason: string; refundable: boolean; sourceCorrelation?: FundingSourceCorrelation }

export type FundingSourceQuoteInput = {
  provider: FundingSourceProviderId
  amountUsd: number
}

export type FundingSourceQuote = {
  provider: FundingSourceProviderId
  quoteHash: string
  amountUsd: number
}

export type FundingSourceAcquireInput = {
  provider: FundingSourceProviderId
  // pirate_checkout: the buyer already submitted the Base USDC tx; its hash is the acquisition.
  fundingTxRef?: string | null
  // omniston_ton: correlation handles from a prior cross-chain quote / wallet approval.
  sourceTxRef?: string | null
  routeRef?: string | null
}

export type FundingSourceProvider = {
  provider: FundingSourceProviderId
  quoteFunding(input: FundingSourceQuoteInput): Promise<FundingSourceQuote>
  acquireFunding(input: FundingSourceAcquireInput): Promise<FundingAcquisition>
}
