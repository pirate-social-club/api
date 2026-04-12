import type {
  CommunityPurchaseQuote,
  CommunityPurchaseQuoteRequest,
  Env,
} from "../../types"
import { badRequestError, eligibilityFailed } from "../errors"
import { verifyPirateAccessToken } from "../auth/pirate-session-token"
import { makeId, nowIso } from "../helpers"
import type { UserRepository } from "../auth/repositories"
import type { CommunityRepository } from "./control-plane-community-repository"
import { openCommunityDb } from "./community-db-factory"
import { getCommunityListingById } from "./community-listing-store"
import { insertCommunityPurchaseQuote } from "./community-purchase-quote-store"
import { insertCommunityPurchaseQuoteVerificationSnapshot } from "./community-purchase-quote-verification-snapshot-store"
import { assertCommunityFundingQuoteEligible, resolveCommunityMoneyPolicy } from "./community-money-policy-service"
import { resolveCommunityPricingPolicy } from "./community-pricing-policy-service"
import { assertNonEmptyString, assertNullableString, isRecord } from "../validation"

function assertCommunityPurchaseQuoteRequest(value: unknown): asserts value is CommunityPurchaseQuoteRequest {
  if (!isRecord(value)) {
    throw badRequestError("Invalid community purchase quote payload")
  }

  assertNonEmptyString(value.listing_id, "listing_id")

  if (value.funding_asset !== undefined && value.funding_asset !== null && !isRecord(value.funding_asset)) {
    throw badRequestError("funding_asset must be an object or null")
  }
  if (value.source_chain !== undefined && value.source_chain !== null && !isRecord(value.source_chain)) {
    throw badRequestError("source_chain must be an object or null")
  }
  assertNullableString(value.route_provider, "route_provider")

  if (!Number.isInteger(value.client_estimated_slippage_bps) || Number(value.client_estimated_slippage_bps) < 0) {
    throw badRequestError("client_estimated_slippage_bps must be a non-negative integer")
  }
  if (!Number.isInteger(value.client_estimated_hop_count) || Number(value.client_estimated_hop_count) < 0) {
    throw badRequestError("client_estimated_hop_count must be a non-negative integer")
  }
  if (
    value.client_route_valid_for_seconds != null
    && (!Number.isInteger(value.client_route_valid_for_seconds) || Number(value.client_route_valid_for_seconds) < 0)
  ) {
    throw badRequestError("client_route_valid_for_seconds must be a non-negative integer or null")
  }

  const amountAtomic = value.destination_settlement_amount_atomic
  const decimals = value.destination_settlement_decimals
  if (amountAtomic != null || decimals != null) {
    if (typeof amountAtomic !== "string" || !/^[1-9]\d*$/.test(amountAtomic.trim())) {
      throw badRequestError("destination_settlement_amount_atomic must be a positive integer string")
    }
    if (!Number.isInteger(decimals) || Number(decimals) < 0 || Number(decimals) > 36) {
      throw badRequestError("destination_settlement_decimals must be an integer between 0 and 36")
    }
  }
}

export async function quoteCommunityPurchase(input: {
  env: Env
  bearerToken: string
  communityId: string
  body: unknown
  repository: CommunityRepository
  userRepository: UserRepository
}): Promise<CommunityPurchaseQuote> {
  const session = await verifyPirateAccessToken({
    token: input.bearerToken,
    env: input.env,
  })
  assertCommunityPurchaseQuoteRequest(input.body)

  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const listing = await getCommunityListingById({
      client: db.client,
      communityId: input.communityId,
      listingId: input.body.listing_id.trim(),
    })
    if (listing.status !== "active") {
      throw eligibilityFailed("Listing is not available for purchase")
    }

    const resolvedPolicy = await resolveCommunityMoneyPolicy({
      repository: input.repository,
      communityId: input.communityId,
    })
    const policy = await assertCommunityFundingQuoteEligible({
      communityId: input.communityId,
      repository: input.repository,
      fundingAsset: input.body.funding_asset == null
        ? null
        : {
            assetSymbol: input.body.funding_asset.asset_symbol,
            chainNamespace: input.body.funding_asset.chain_namespace ?? null,
            chainId: input.body.funding_asset.chain_id ?? null,
          },
      sourceChain: input.body.source_chain == null
        ? null
        : {
            chainNamespace: input.body.source_chain.chain_namespace,
            chainId: input.body.source_chain.chain_id ?? null,
          },
      routeProvider: input.body.route_provider ?? null,
      destinationSettlementChain: {
        chainNamespace: resolvedPolicy.destination_settlement_chain.chain_namespace,
        chainId: resolvedPolicy.destination_settlement_chain.chain_id ?? null,
      },
      destinationSettlementToken: resolvedPolicy.destination_settlement_token,
      estimatedSlippageBps: input.body.client_estimated_slippage_bps,
      estimatedHopCount: input.body.client_estimated_hop_count,
      routeValidForSeconds: input.body.client_route_valid_for_seconds ?? null,
    })
    const routeRequested = input.body.route_provider != null || input.body.funding_asset != null || input.body.source_chain != null
    const fundingMode: CommunityPurchaseQuote["funding_mode"] = (policy.route_required || routeRequested) ? "routed" : "direct"

    const quotedAt = nowIso()
    const expiresAt = new Date(Date.parse(quotedAt) + policy.quote_ttl_seconds * 1000).toISOString()

    const quoteId = makeId("qte")
    const buyer = await input.userRepository.getUserById(session.userId)
    if (!buyer) {
      throw eligibilityFailed("Buyer not found")
    }

    const pricingPolicy = await resolveCommunityPricingPolicy({
      repository: input.repository,
      communityId: input.communityId,
    })
    const pricingCandidate = resolveListingPrice({
      listingBasePriceUsd: listing.price_usd,
      listingRegionalPricingEnabled: listing.regional_pricing_policy?.enabled === true,
      pricingPolicy,
      buyerNationalityCapability: buyer.verification_capabilities.nationality,
    })

    const verificationSnapshotRef = pricingCandidate.snapshot != null ? makeId("vsr") : null

    const quote: CommunityPurchaseQuote = {
      quote_id: quoteId,
      community_id: input.communityId,
      listing_id: listing.listing_id,
      buyer_user_id: session.userId,
      asset_id: listing.asset_id,
      live_room_id: listing.live_room_id,
      base_price_usd: listing.price_usd,
      pricing_tier: pricingCandidate.pricingTier,
      final_price_usd: pricingCandidate.finalPriceUsd,
      funding_mode: fundingMode,
      funding_asset: input.body.funding_asset ?? null,
      source_chain: input.body.source_chain ?? null,
      route_provider: input.body.route_provider ?? null,
      route_policy_compliant: true,
      route_live_available: null,
      policy_origin: policy.policy_origin,
      destination_settlement_chain: policy.destination_settlement_chain,
      destination_settlement_token: policy.destination_settlement_token,
      destination_settlement_amount_atomic: input.body.destination_settlement_amount_atomic?.trim() ?? null,
      destination_settlement_decimals: input.body.destination_settlement_decimals ?? null,
      treasury_denomination: policy.treasury_denomination ?? null,
      quote_ttl_seconds: policy.quote_ttl_seconds,
      route_required: policy.route_required,
      route_status_policy: policy.route_status_policy,
      route_hop_tolerance: policy.route_hop_tolerance,
      verification_snapshot_ref: verificationSnapshotRef,
      pricing_policy_version: pricingCandidate.pricingPolicyVersion,
      quoted_at: quotedAt,
      expires_at: expiresAt,
    }

    await insertCommunityPurchaseQuote({
      client: db.client,
      quote,
    })

    if (verificationSnapshotRef != null && pricingCandidate.snapshot != null) {
      await insertCommunityPurchaseQuoteVerificationSnapshot({
        client: db.client,
        verificationSnapshotRef,
        communityId: input.communityId,
        quoteId,
        buyerUserId: session.userId,
        provider: pricingCandidate.snapshot.provider,
        nationalityState: pricingCandidate.snapshot.nationality_state,
        nationalityValue: pricingCandidate.snapshot.nationality_value,
        pricingTier: pricingCandidate.snapshot.pricing_tier,
        pricingPolicyVersion: pricingCandidate.snapshot.pricing_policy_version,
        snapshotJson: JSON.stringify(pricingCandidate.snapshot),
        createdAt: pricingCandidate.snapshot.created_at,
      })
    }

    return quote
  } finally {
    db.close()
  }
}

function roundUsd(value: number): number {
  return Math.round(value * 100) / 100
}

function resolveListingPrice(input: {
  listingBasePriceUsd: number
  listingRegionalPricingEnabled: boolean
  pricingPolicy: Awaited<ReturnType<typeof resolveCommunityPricingPolicy>>
  buyerNationalityCapability: {
    state: string
    value?: string | null
    provider?: string | null
    verified_at?: string | null
  }
}): {
  pricingTier: string | null
  finalPriceUsd: number
  pricingPolicyVersion: string | null
  snapshot: {
    provider: string | null
    nationality_state: string
    nationality_value: string | null
    pricing_tier: string | null
    pricing_policy_version: string
    created_at: string
  } | null
} {
  if (!input.listingRegionalPricingEnabled || !input.pricingPolicy.regional_pricing_enabled) {
    return {
      pricingTier: null,
      finalPriceUsd: input.listingBasePriceUsd,
      pricingPolicyVersion: null,
      snapshot: null,
    }
  }

  const nationality = input.buyerNationalityCapability
  if (
    nationality.state !== "verified"
    || nationality.provider !== input.pricingPolicy.verification_provider_requirement
    || typeof nationality.value !== "string"
    || nationality.value.trim().length === 0
  ) {
    return {
      pricingTier: null,
      finalPriceUsd: input.listingBasePriceUsd,
      pricingPolicyVersion: input.pricingPolicy.pricing_policy_version,
      snapshot: {
        provider: nationality.provider ?? null,
        nationality_state: nationality.state,
        nationality_value: typeof nationality.value === "string" ? nationality.value.trim().toUpperCase() : null,
        pricing_tier: null,
        pricing_policy_version: input.pricingPolicy.pricing_policy_version,
        created_at: nowIso(),
      },
    }
  }

  const countryCode = nationality.value.trim().toUpperCase()
  const resolvedTierKey = input.pricingPolicy.country_assignments.find((assignment) => assignment.country_code === countryCode)?.tier_key
    ?? input.pricingPolicy.default_tier_key
    ?? null
  if (resolvedTierKey == null) {
    return {
      pricingTier: null,
      finalPriceUsd: input.listingBasePriceUsd,
      pricingPolicyVersion: input.pricingPolicy.pricing_policy_version,
      snapshot: {
        provider: nationality.provider ?? null,
        nationality_state: nationality.state,
        nationality_value: countryCode,
        pricing_tier: null,
        pricing_policy_version: input.pricingPolicy.pricing_policy_version,
        created_at: nowIso(),
      },
    }
  }

  const tier = input.pricingPolicy.tiers.find((candidate) => candidate.tier_key === resolvedTierKey)
  if (!tier) {
    throw eligibilityFailed(`Community pricing policy tier is missing: ${resolvedTierKey}`)
  }

  const finalPriceUsd = tier.adjustment_type === "multiplier"
    ? roundUsd(input.listingBasePriceUsd * tier.adjustment_value)
    : roundUsd(tier.adjustment_value)

  return {
    pricingTier: tier.tier_key,
    finalPriceUsd,
    pricingPolicyVersion: input.pricingPolicy.pricing_policy_version,
    snapshot: {
      provider: nationality.provider ?? null,
      nationality_state: nationality.state,
      nationality_value: countryCode,
      pricing_tier: tier.tier_key,
      pricing_policy_version: input.pricingPolicy.pricing_policy_version,
      created_at: nowIso(),
    },
  }
}
