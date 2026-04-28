import { eligibilityFailed, notFoundError } from "../../errors"
import { makeId, nowIso } from "../../helpers"
import { openCommunityDb } from "../community-db-factory"
import type { CommunityDatabaseBindingRepository } from "../db-community-repository"
import type { UserRepository } from "../../auth/repositories"
import {
  boolToSqlite,
  getAssetRow,
  getListingRowById,
  parseListingPolicy,
  getPurchaseQuoteRow,
  requireCommunityMember,
  serializeListing,
  serializeQuote,
} from "./shared"
import {
  getCommunityMoneyPolicy,
  getCommunityPricingPolicy,
} from "./policy-service"
import { assertAssetReadyForStoryRoyaltyCommerce } from "./story-royalty"
import { resolveStorySettlementDirectSigner } from "../../story/story-direct-signer"
import {
  resolvePirateCheckoutOperatorAddress,
} from "./checkout-config"
import { assertEndaomentPayoutConfigured } from "./endaoment-payout-service"
import {
  assertValidDonationSharePct,
  resolveBestVerifiedRegionalPrice,
  resolveAllocationSettlementAmountAtomic,
  resolvePurchaseSettlementMode,
  resolveRegionalPrice,
  resolveRoutePolicy,
} from "./quote-helpers"
import {
  assertExecutableQuoteAllocationSnapshot,
  resolveQuoteAllocationSnapshot,
} from "./allocation"
import type {
  CommunityPurchaseQuote,
  CommunityPurchaseQuotePreflight,
  CommunityPurchaseQuotePreflightRequest,
  CommunityPurchaseQuoteRequest,
  CommunityPurchaseSettlementFailure,
  CommunityPurchaseSettlementFailureRequest,
  Env,
} from "../../../types"

export async function preflightCommunityPurchaseQuote(input: {
  env: Env
  userId: string
  communityId: string
  body: CommunityPurchaseQuotePreflightRequest
  communityRepository: CommunityDatabaseBindingRepository
  userRepository: UserRepository
}): Promise<CommunityPurchaseQuotePreflight> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const moneyPolicy = await getCommunityMoneyPolicy({ env: input.env, communityId: input.communityId })
    const route = resolveRoutePolicy({ moneyPolicy, body: input.body })
    const pricingPolicy = await getCommunityPricingPolicy({ env: input.env, communityId: input.communityId })
    const buyer = await input.userRepository.getUserById(input.userId)
    const listing = input.body.listing_id
      ? await getListingRowById(db.client, input.communityId, input.body.listing_id)
      : null
    if (input.body.listing_id && (!listing || listing.status !== "active")) {
      throw notFoundError("Listing not found")
    }
    const serializedListing = listing ? serializeListing(listing) : null
    const resolvedPrice = serializedListing
      ? resolveRegionalPrice({
        listing: serializedListing,
        pricingPolicy,
        buyer,
      })
      : null
    const bestVerifiedPrice = serializedListing
      ? resolveBestVerifiedRegionalPrice({
        listing: serializedListing,
        pricingPolicy,
      })
      : null
    const quotedAt = nowIso()
    const expiresAt = new Date(Date.now() + moneyPolicy.quote_ttl_seconds * 1000).toISOString()
    return {
      community_id: input.communityId,
      eligible: route.eligible,
      funding_mode: route.fundingMode,
      policy_origin: moneyPolicy.policy_origin,
      funding_preference: moneyPolicy.funding_preference,
      funding_asset: input.body.funding_asset ?? null,
      source_chain: input.body.source_chain ?? null,
      route_provider: input.body.route_provider ?? null,
      destination_settlement_chain: moneyPolicy.destination_settlement_chain,
      destination_settlement_token: moneyPolicy.destination_settlement_token,
      treasury_denomination: moneyPolicy.treasury_denomination ?? null,
      max_slippage_bps: moneyPolicy.max_slippage_bps,
      quote_ttl_seconds: moneyPolicy.quote_ttl_seconds,
      route_required: moneyPolicy.route_required,
      route_status_policy: moneyPolicy.route_status_policy,
      route_hop_tolerance: moneyPolicy.route_hop_tolerance,
      base_price_usd: serializedListing?.price_usd ?? null,
      viewer_price_usd: resolvedPrice?.finalPriceUsd ?? null,
      best_verified_price_usd: bestVerifiedPrice?.bestVerifiedPriceUsd ?? null,
      max_self_discount_percent: bestVerifiedPrice?.maxSelfDiscountPercent ?? null,
      verification_required_provider: bestVerifiedPrice?.verificationRequiredProvider ?? null,
      quoted_at: quotedAt,
      expires_at: expiresAt,
    }
  } finally {
    db.close()
  }
}

export async function createCommunityPurchaseQuote(input: {
  env: Env
  userId: string
  communityId: string
  body: CommunityPurchaseQuoteRequest
  communityRepository: CommunityDatabaseBindingRepository
  userRepository: UserRepository
}): Promise<CommunityPurchaseQuote> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const listing = await getListingRowById(db.client, input.communityId, input.body.listing_id)
    if (!listing || listing.status !== "active") {
      throw notFoundError("Listing not found")
    }
    let settlementMode = resolvePurchaseSettlementMode({})
    if (listing.asset_id?.trim()) {
      const asset = await getAssetRow(db.client, input.communityId, listing.asset_id)
      if (!asset) {
        throw notFoundError("Asset not found")
      }
      assertAssetReadyForStoryRoyaltyCommerce(asset, input.env)
      settlementMode = resolvePurchaseSettlementMode({
        storyRoyaltyRegistrationStatus: asset.story_royalty_registration_status,
        storyIpId: asset.story_ip_id,
      })
    }
    const moneyPolicy = await getCommunityMoneyPolicy({ env: input.env, communityId: input.communityId })
    const route = resolveRoutePolicy({ moneyPolicy, body: input.body })
    if (!route.eligible) {
      throw eligibilityFailed("Funding lane does not satisfy community money policy")
    }
    const pricingPolicy = await getCommunityPricingPolicy({ env: input.env, communityId: input.communityId })
    const buyer = await input.userRepository.getUserById(input.userId)
    const resolvedPrice = resolveRegionalPrice({
      listing: serializeListing(listing),
      pricingPolicy,
      buyer,
    })
    const quoteId = makeId("qte")
    const quotedAt = nowIso()
    const expiresAt = new Date(Date.now() + moneyPolicy.quote_ttl_seconds * 1000).toISOString()
    const verificationSnapshotRef = resolvedPrice.verificationSnapshot ? makeId("qvs") : null
    const listingPolicy = parseListingPolicy(listing)

    if (listingPolicy.donationPartnerId) {
      const communityResult = await db.client.execute({
        sql: `
          SELECT donation_policy_mode, donation_partner_status
          FROM communities
          WHERE community_id = ?1
          LIMIT 1
        `,
        args: [input.communityId],
      })
      const communityRow = communityResult.rows[0]
      const donationPolicyMode = String(communityRow?.donation_policy_mode ?? "none")
      const donationPartnerStatus = String(communityRow?.donation_partner_status ?? "unconfigured")

      if (donationPolicyMode === "none") {
        throw eligibilityFailed("Community donation policy does not permit donations")
      }
      if (donationPartnerStatus !== "active") {
        throw eligibilityFailed("Community donation partner is not active")
      }

      const partnerResult = await db.client.execute({
        sql: `
          SELECT provider, review_status, status, payout_destination_ref
          FROM donation_partners
          WHERE donation_partner_id = ?1
          LIMIT 1
        `,
        args: [listingPolicy.donationPartnerId],
      })
      const partnerRow = partnerResult.rows[0]
      if (
        !partnerRow
        || String(partnerRow.review_status) !== "approved"
        || String(partnerRow.status) !== "active"
      ) {
        throw eligibilityFailed("Donation partner is not available")
      }
      if (!String(partnerRow.payout_destination_ref ?? "").trim()) {
        throw eligibilityFailed("Donation partner payout destination is not configured")
      }
      if (String(partnerRow.provider) === "endaoment") {
        try {
          assertEndaomentPayoutConfigured(input.env)
        } catch {
          throw eligibilityFailed("Donation partner payout provider is not available")
        }
      } else {
        throw eligibilityFailed("Donation partner provider is not supported")
      }

      assertValidDonationSharePct(listingPolicy.donationSharePct)
    }

    const allocationSnapshot = assertExecutableQuoteAllocationSnapshot(
      resolveQuoteAllocationSnapshot({
        finalPriceUsd: resolvedPrice.finalPriceUsd,
        listingPolicy,
      }),
    )
    const settlementAmount = {
      amountAtomic: resolveAllocationSettlementAmountAtomic({
        allocations: allocationSnapshot,
        settlementStrategy: "story_payout",
      }).toString(),
      decimals: 18,
    }
    let fundingDestinationAddress: string | null = null
    if (settlementMode === "royalty_native_story_payment") {
      if (route.fundingMode !== "routed") {
        throw eligibilityFailed("Story royalty commerce requires routed buyer funding")
      }
      const settlementSigner = resolveStorySettlementDirectSigner(input.env)
      if (!settlementSigner.ok) {
        throw eligibilityFailed(settlementSigner.error)
      }
      if (!settlementSigner.value) {
        throw eligibilityFailed("Story settlement operator is not configured")
      }
      fundingDestinationAddress = resolvePirateCheckoutOperatorAddress(input.env)
    }
    await db.client.execute({
      sql: `
        INSERT INTO purchase_quotes (
          quote_id, community_id, listing_id, buyer_user_id, asset_id, live_room_id, base_price_usd,
          pricing_tier, final_price_usd, allocation_snapshot_json, funding_mode, funding_asset_json, source_chain_json,
          route_provider, funding_destination_address, route_policy_compliant, route_live_available, policy_origin,
          destination_settlement_chain_json, destination_settlement_token, destination_settlement_amount_atomic,
          destination_settlement_decimals, treasury_denomination,
          quote_ttl_seconds, route_required, route_status_policy, route_hop_tolerance,
          settlement_mode, verification_snapshot_ref, pricing_policy_version, status, quoted_at, expires_at,
          consumed_at, failed_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, NULL, ?6,
          ?7, ?8, ?9, ?10, ?11, ?12, ?13,
          ?14, ?15, ?16, ?17, ?18, ?19,
          ?20, ?21, ?22, ?23, ?24, ?25,
          ?26, ?27, ?28, ?29, 'active', ?30, ?31,
          NULL, NULL, ?30, ?30
        )
      `,
      args: [
        quoteId,
        input.communityId,
        listing.listing_id,
        input.userId,
        listing.asset_id,
        listing.price_usd,
        resolvedPrice.pricingTier,
        resolvedPrice.finalPriceUsd,
        JSON.stringify(allocationSnapshot),
        route.fundingMode,
        input.body.funding_asset ? JSON.stringify(input.body.funding_asset) : null,
        input.body.source_chain ? JSON.stringify(input.body.source_chain) : null,
        input.body.route_provider ?? null,
        fundingDestinationAddress,
        boolToSqlite(route.routePolicyCompliant),
        route.routeLiveAvailable == null ? null : boolToSqlite(route.routeLiveAvailable),
        moneyPolicy.policy_origin,
        JSON.stringify(moneyPolicy.destination_settlement_chain),
        moneyPolicy.destination_settlement_token,
        settlementAmount.amountAtomic,
        settlementAmount.decimals,
        moneyPolicy.treasury_denomination ?? null,
        moneyPolicy.quote_ttl_seconds,
        boolToSqlite(moneyPolicy.route_required),
        moneyPolicy.route_status_policy,
        moneyPolicy.route_hop_tolerance,
        settlementMode,
        verificationSnapshotRef,
        resolvedPrice.pricingTier ? pricingPolicy.pricing_policy_version : null,
        quotedAt,
        expiresAt,
      ],
    })
    if (verificationSnapshotRef) {
      await db.client.execute({
        sql: `
          INSERT INTO purchase_quote_verification_snapshots (
            verification_snapshot_ref, community_id, quote_id, buyer_user_id, provider, nationality_state,
            nationality_value, pricing_tier, pricing_policy_version, snapshot_json, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5, ?6,
            ?7, ?8, ?9, ?10, ?11, ?11
          )
        `,
        args: [
          verificationSnapshotRef,
          input.communityId,
          quoteId,
          input.userId,
          String(resolvedPrice.verificationSnapshot?.provider ?? "self"),
          String(resolvedPrice.verificationSnapshot?.nationality_state ?? "verified"),
          String(resolvedPrice.verificationSnapshot?.nationality_value ?? ""),
          resolvedPrice.pricingTier,
          pricingPolicy.pricing_policy_version,
          JSON.stringify(resolvedPrice.verificationSnapshot),
          quotedAt,
        ],
      })
    }
    const quote = await getPurchaseQuoteRow(db.client, input.communityId, quoteId)
    if (!quote) {
      throw notFoundError("Quote not found")
    }
    return serializeQuote(quote)
  } finally {
    db.close()
  }
}

export async function failCommunityPurchase(input: {
  env: Env
  userId: string
  communityId: string
  body: CommunityPurchaseSettlementFailureRequest
  communityRepository: CommunityDatabaseBindingRepository
}): Promise<CommunityPurchaseSettlementFailure> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const quote = await getPurchaseQuoteRow(db.client, input.communityId, input.body.quote_id)
    if (!quote || quote.buyer_user_id !== input.userId) {
      throw notFoundError("Purchase quote not found")
    }
    const now = nowIso()
    const expired = new Date(quote.expires_at).getTime() <= Date.now()
    const nextStatus = expired ? "expired" : "failed"
    await db.client.execute({
      sql: `
        UPDATE purchase_quotes
        SET status = ?3,
            failed_at = CASE WHEN ?3 = 'failed' THEN ?4 ELSE failed_at END,
            updated_at = ?4
        WHERE community_id = ?1
          AND quote_id = ?2
      `,
      args: [input.communityId, input.body.quote_id, nextStatus, now],
    })
    return {
      quote_id: quote.quote_id,
      community_id: quote.community_id,
      status: nextStatus,
      failed_at: nextStatus === "failed" ? now : null,
      expires_at: quote.expires_at,
    }
  } finally {
    db.close()
  }
}
