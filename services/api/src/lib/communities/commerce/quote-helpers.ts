import { badRequestError } from "../../errors"
import type { UserRepository } from "../../auth/repositories"
import {
  parseJsonValue,
  type PurchaseAllocationLegRow,
  type PurchaseEntitlementRow,
  type PurchaseQuoteRow,
  type PurchaseRow,
  type PurchaseSettlementMode,
  toChainRefString,
} from "./shared"
import { serializePurchaseAllocationLeg } from "./allocation"
import type {
  CommunityListing,
  CommunityMoneyPolicy,
  CommunityPurchase,
  CommunityPurchaseQuotePreflightRequest,
  CommunityPurchaseSettlement,
  CommunityPricingPolicy,
} from "../../../types"

export function roundUsd(value: number): number {
  return Math.round(value * 100) / 100
}

export function assertValidDonationSharePct(value: unknown): number {
  const pct = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN
  if (!Number.isInteger(pct) || pct <= 0 || pct > 50) {
    throw badRequestError("donation_share_pct must be an integer between 1 and 50")
  }
  return pct
}

export function resolveSettlementAmountSnapshot(finalPriceUsd: number): {
  amountAtomic: string
  decimals: number
} {
  const roundedUsd = roundUsd(finalPriceUsd)
  const cents = Math.round(roundedUsd * 100)
  if (!Number.isFinite(roundedUsd) || cents <= 0) {
    throw badRequestError("Settlement amount must be positive")
  }
  return {
    amountAtomic: String(BigInt(cents) * 10n ** 16n),
    decimals: 18,
  }
}

export function resolvePurchaseSettlementMode(input: {
  storyRoyaltyRegistrationStatus?: string | null
  storyIpId?: string | null
}): PurchaseSettlementMode {
  return input.storyRoyaltyRegistrationStatus === "registered" && Boolean(input.storyIpId?.trim())
    ? "royalty_native_story_payment"
    : "delivery_only_story_settlement"
}

export function parseQuoteSettlementAmountAtomic(quote: PurchaseQuoteRow): bigint {
  const raw = String(quote.destination_settlement_amount_atomic || "").trim()
  if (raw) {
    try {
      const parsed = BigInt(raw)
      if (parsed > 0n) {
        return parsed
      }
    } catch {
      // Fall through to the derived amount below.
    }
  }
  return BigInt(resolveSettlementAmountSnapshot(quote.final_price_usd).amountAtomic)
}

export function resolveAllocationSettlementAmountAtomic(input: {
  allocations: PurchaseAllocationLegRow[] | Array<{
    amount_usd: number
    settlement_strategy: string
  }>
  settlementStrategy: string
}): bigint {
  const amountUsd = input.allocations
    .filter((allocation) => allocation.settlement_strategy === input.settlementStrategy)
    .reduce((sum, allocation) => sum + allocation.amount_usd, 0)
  return BigInt(resolveSettlementAmountSnapshot(roundUsd(amountUsd)).amountAtomic)
}

function toSettlementEntitlementKind(
  entitlementKind: CommunityPurchase["entitlement_kind"],
): CommunityPurchaseSettlement["entitlement_kind"] {
  return entitlementKind === "live_room_access" ? "live_room_access" : "asset_access"
}

export function serializeSettlement(
  purchase: PurchaseRow,
  entitlement: PurchaseEntitlementRow,
  quote: PurchaseQuoteRow,
  allocations: PurchaseAllocationLegRow[],
): CommunityPurchaseSettlement {
  const settlementChain = parseJsonValue<CommunityPurchaseSettlement["settlement_chain"]>(
    purchase.settlement_chain,
    { chain_namespace: "eip155", chain_id: 1315, display_name: "Story Aeneid" },
  )
  return {
    purchase_id: purchase.purchase_id,
    quote_id: quote.quote_id,
    community_id: purchase.community_id,
    listing_id: purchase.listing_id,
    buyer_user_id: purchase.buyer_user_id,
    asset_id: purchase.asset_id,
    live_room_id: purchase.live_room_id,
    settlement_wallet_attachment_id: purchase.settlement_wallet_attachment_id,
    purchase_price_usd: purchase.purchase_price_usd,
    pricing_tier: purchase.pricing_tier,
    settlement_mode: purchase.settlement_mode,
    settlement_chain: settlementChain,
    settlement_chain_ref: toChainRefString(settlementChain),
    settlement_token: purchase.settlement_token,
    settlement_tx_ref: purchase.settlement_tx_ref,
    allocations: allocations.map(serializePurchaseAllocationLeg),
    donation_partner_id: purchase.donation_partner_id,
    donation_share_pct: purchase.donation_share_pct,
    donation_amount_usd: purchase.donation_amount_usd,
    entitlement_kind: toSettlementEntitlementKind(entitlement.entitlement_kind),
    entitlement_target_ref: entitlement.target_ref,
    purchase_entitlement_id: entitlement.purchase_entitlement_id,
    settled_at: purchase.created_at,
  }
}

export function resolveRegionalPrice(input: {
  listing: CommunityListing
  pricingPolicy: CommunityPricingPolicy
  buyer: Awaited<ReturnType<UserRepository["getUserById"]>>
}): { finalPriceUsd: number; pricingTier: string | null; verificationSnapshot: Record<string, unknown> | null } {
  const basePriceUsd = input.listing.price_usd
  if (!input.listing.regional_pricing_enabled || !input.pricingPolicy.regional_pricing_enabled || !input.buyer) {
    return { finalPriceUsd: basePriceUsd, pricingTier: null, verificationSnapshot: null }
  }
  const nationality = input.buyer.verification_capabilities.nationality
  if (nationality.state !== "verified" || nationality.provider !== "self") {
    return { finalPriceUsd: basePriceUsd, pricingTier: null, verificationSnapshot: null }
  }
  const countryCode = (nationality.value || "").toUpperCase()
  const assignment = input.pricingPolicy.country_assignments.find((entry) => entry.country_code === countryCode)
  const tierKey = assignment?.tier_key || input.pricingPolicy.default_tier_key || null
  if (!tierKey) {
    return { finalPriceUsd: basePriceUsd, pricingTier: null, verificationSnapshot: null }
  }
  const tier = input.pricingPolicy.tiers.find((entry) => entry.tier_key === tierKey)
  if (!tier) {
    return { finalPriceUsd: basePriceUsd, pricingTier: null, verificationSnapshot: null }
  }
  const finalPriceUsd = roundUsd(basePriceUsd * tier.adjustment_value)
  return {
    finalPriceUsd,
    pricingTier: tier.tier_key,
    verificationSnapshot: {
      nationality_state: nationality.state,
      nationality_value: countryCode || null,
      provider: nationality.provider,
      pricing_tier: tier.tier_key,
      pricing_policy_version: input.pricingPolicy.pricing_policy_version,
    },
  }
}

export function resolveRoutePolicy(input: {
  moneyPolicy: CommunityMoneyPolicy
  body: CommunityPurchaseQuotePreflightRequest
}): {
  eligible: boolean
  fundingMode: "direct" | "routed"
  routePolicyCompliant: boolean
  routeLiveAvailable: boolean | null
} {
  const routeRequired = input.moneyPolicy.route_required
  if (!routeRequired) {
    return {
      eligible: true,
      fundingMode: "direct",
      routePolicyCompliant: true,
      routeLiveAvailable: null,
    }
  }
  const providerAllowed = !input.moneyPolicy.approved_route_providers?.length
    || (!!input.body.route_provider && input.moneyPolicy.approved_route_providers.includes(input.body.route_provider))
  const fundingAssetAllowed = !input.moneyPolicy.accepted_funding_assets.length
    || input.moneyPolicy.accepted_funding_assets.some((asset) =>
      asset.asset_symbol === input.body.funding_asset?.asset_symbol
      && (asset.chain_namespace ?? null) === (input.body.funding_asset?.chain_namespace ?? null)
      && (asset.chain_id ?? null) === (input.body.funding_asset?.chain_id ?? null))
  const sourceChainAllowed = !input.moneyPolicy.accepted_source_chains.length
    || input.moneyPolicy.accepted_source_chains.some((chain) =>
      chain.chain_namespace === input.body.source_chain?.chain_namespace
      && (chain.chain_id ?? null) === (input.body.source_chain?.chain_id ?? null))
  const routePolicyCompliant = providerAllowed
    && fundingAssetAllowed
    && sourceChainAllowed
    && input.body.client_estimated_slippage_bps <= input.moneyPolicy.max_slippage_bps
    && input.body.client_estimated_hop_count <= input.moneyPolicy.route_hop_tolerance
  return {
    eligible: routePolicyCompliant,
    fundingMode: "routed",
    routePolicyCompliant,
    routeLiveAvailable: routePolicyCompliant,
  }
}
