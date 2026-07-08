import { badRequestError, eligibilityFailed, notFoundError } from "../../errors"
import { makeId, nowIso } from "../../helpers"
import { decodePublicId } from "../../public-ids"
import { nullableUnixSeconds, unixSeconds } from "../../../serializers/time"
import { openCommunityReadClient, openCommunityWriteClient } from "../community-read-access"
import type { CommunityDatabaseBindingRepository } from "../db-community-repository"
import type { UserRepository } from "../../auth/repositories"
import { getPostById } from "../../posts/community-post-query-store"
import { isPubliclyReadablePost } from "../../posts/post-access"
import {
  boolToSqlite,
} from "./row-types"
import {
  getAssetRow,
  getListingRowById,
  getPurchaseQuoteRow,
} from "./queries"
import {
  requireCommunityMember,
} from "./access"
import {
  parseListingPolicy,
  serializeListing,
  serializeQuote,
  usdToCents,
} from "./serialization"
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
  roundUsd,
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
import {
  type BuyerIdentity,
  buyerIdentityFields,
  buyerMatchesFields,
  userBuyer,
} from "./buyer-identity"
import type { PurchaseQuoteRow } from "./row-types"
import type { QuoteAllocationSnapshot } from "./row-types"
import {
  getLiveRoomReplayAssetById,
  listLiveRoomReplayAllocations,
} from "../live-rooms/replay-assets"
import type {
  CommunityPurchaseQuote,
  CommunityPurchaseQuotePreflight,
  CommunityPurchaseQuotePreflightRequest,
  CommunityPurchaseQuoteRequest,
  CommunityPurchaseSettlementFailure,
  CommunityPurchaseSettlementFailureRequest,
  Env,
} from "../../../types"

function resolveReplayQuoteAllocationSnapshot(input: {
  finalPriceUsd: number
  replayAllocations: Awaited<ReturnType<typeof listLiveRoomReplayAllocations>>
  listingPolicy: {
    donationPartnerId: string | null
    donationSharePct: number | null
  }
}): QuoteAllocationSnapshot[] {
  const charitySharePct = Number.isInteger(input.listingPolicy.donationSharePct)
    ? Math.max(0, Math.min(100, input.listingPolicy.donationSharePct ?? 0))
    : 0
  const charityShareBps = charitySharePct * 100
  const charityRecipientRef = input.listingPolicy.donationPartnerId?.trim() || null
  const charityAmountUsd = charityShareBps > 0 && charityRecipientRef
    ? roundUsd(input.finalPriceUsd * (charityShareBps / 10_000))
    : 0
  const payableAmountUsd = roundUsd(input.finalPriceUsd - charityAmountUsd)
  if (input.replayAllocations.some((allocation) => allocation.external_party_ref !== null)) {
    throw badRequestError("Paid replay cannot be sold while an allocation names an external rightsholder without a payable Pirate identity")
  }
  const approvedReplayAllocations = input.replayAllocations.filter((allocation) => allocation.approval_status === "approved")
  const replayShareBps = approvedReplayAllocations.reduce((sum, allocation) => sum + allocation.share_bps, 0)
  if (approvedReplayAllocations.length === 0 || replayShareBps !== 10_000) {
    throw badRequestError("Replay allocations must be approved and sum to 100% before paid replay can be sold")
  }

  const allocations: QuoteAllocationSnapshot[] = []
  if (charityAmountUsd > 0 && charityRecipientRef) {
    allocations.push({
      recipient_type: "charity",
      recipient_ref: charityRecipientRef,
      waterfall_position: 60,
      share_bps: charityShareBps,
      amount_usd: charityAmountUsd,
      settlement_strategy: "provider_payout",
    })
  }
  let allocatedUsd = 0
  let allocatedBps = charityShareBps
  approvedReplayAllocations.forEach((allocation, index) => {
    const isLast = index === approvedReplayAllocations.length - 1
    const amountUsd = isLast
      ? roundUsd(payableAmountUsd - allocatedUsd)
      : roundUsd(payableAmountUsd * (allocation.share_bps / 10_000))
    const shareBps = isLast
      ? 10_000 - allocatedBps
      : Math.round((10_000 - charityShareBps) * (allocation.share_bps / 10_000))
    allocatedUsd = roundUsd(allocatedUsd + amountUsd)
    allocatedBps += shareBps
    allocations.push({
      recipient_type: "performer",
      recipient_ref: allocation.participant_user_id ?? allocation.external_party_ref,
      waterfall_position: 70 + index,
      share_bps: shareBps,
      amount_usd: amountUsd,
      settlement_strategy: "story_payout",
    })
  })
  return allocations
}

function assertDonationsSupportedForListingTarget(input: {
  assetId?: string | null
  liveRoomId?: string | null
  replayAssetId?: string | null
  donationPartnerId?: string | null
}): void {
  if (!input.donationPartnerId?.trim()) {
    return
  }
  if (input.assetId?.trim()) {
    return
  }
  if (input.liveRoomId?.trim()) {
    return
  }
  if (input.replayAssetId?.trim()) {
    return
  }
  throw eligibilityFailed("Listing charity requires a supported listing target")
}

export async function preflightCommunityPurchaseQuote(input: {
  env: Env
  userId: string
  communityId: string
  body: CommunityPurchaseQuotePreflightRequest
  communityRepository: CommunityDatabaseBindingRepository
  userRepository: UserRepository
}): Promise<CommunityPurchaseQuotePreflight> {
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const moneyPolicy = await getCommunityMoneyPolicy({ env: input.env, communityId: input.communityId })
    const route = resolveRoutePolicy({ moneyPolicy, body: input.body })
    const pricingPolicy = await getCommunityPricingPolicy({ env: input.env, communityId: input.communityId })
    const buyer = await input.userRepository.getUserById(input.userId)
    const listingId = input.body.listing ? decodePublicId(input.body.listing, "lst") : null
    const listing = listingId
      ? await getListingRowById(db.client, input.communityId, listingId)
      : null
    if (listingId && (!listing || listing.status !== "active")) {
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
      community: `com_${input.communityId}`,
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
      base_price_cents: usdToCents(listing?.price_usd ?? null),
      viewer_price_cents: usdToCents(resolvedPrice?.finalPriceUsd ?? null),
      best_verified_price_cents: usdToCents(bestVerifiedPrice?.bestVerifiedPriceUsd ?? null),
      max_self_discount_bps: typeof bestVerifiedPrice?.maxSelfDiscountPercent === "number"
        ? Math.round(bestVerifiedPrice.maxSelfDiscountPercent * 100)
        : null,
      verification_required_provider: bestVerifiedPrice?.verificationRequiredProvider ?? null,
      quoted_at: unixSeconds(quotedAt),
      expires_at: unixSeconds(expiresAt),
    }
  } finally {
    db.close()
  }
}

export type PublicCommunityPurchaseQuote = Omit<CommunityPurchaseQuote, "buyer_user"> & {
  buyer_kind: "wallet"
  buyer_wallet: {
    chain_ref: string
    address: string
  }
}

function serializePublicQuote(row: PurchaseQuoteRow): PublicCommunityPurchaseQuote {
  const serialized = serializeQuote({
    ...row,
    buyer_kind: "user",
    buyer_user_id: "public-wallet-buyer",
  })
  const { buyer_user: _buyerUser, ...rest } = serialized
  return {
    ...rest,
    buyer_kind: "wallet",
    buyer_wallet: {
      chain_ref: row.buyer_chain_ref ?? "eip155",
      address: row.buyer_wallet_address ?? "",
    },
  }
}

async function createCommunityPurchaseQuoteRowForBuyer(input: {
  env: Env
  buyer: BuyerIdentity
  userId?: string
  publicBuyer?: boolean
  communityId: string
  body: CommunityPurchaseQuoteRequest
  communityRepository: CommunityDatabaseBindingRepository
  userRepository: UserRepository
}): Promise<PurchaseQuoteRow> {
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    if (input.userId) {
      await requireCommunityMember(db.client, input.communityId, input.userId)
    }
    const buyerFields = buyerIdentityFields(input.buyer)
    const listing = await getListingRowById(db.client, input.communityId, decodePublicId(input.body.listing, "lst"))
    if (!listing || listing.status !== "active") {
      throw notFoundError("Listing not found")
    }
    let settlementMode = resolvePurchaseSettlementMode({})
    let replayAllocationSnapshot: QuoteAllocationSnapshot[] | null = null
    if (listing.asset_id?.trim()) {
      const asset = await getAssetRow(db.client, input.communityId, listing.asset_id)
      if (!asset) {
        throw notFoundError("Asset not found")
      }
      if (input.publicBuyer) {
        if (asset.access_mode !== "locked" || asset.locked_delivery_status !== "ready") {
          throw notFoundError("Listing not found")
        }
        const post = await getPostById(db.client, asset.source_post_id)
        if (!post || !isPubliclyReadablePost(post)) {
          throw notFoundError("Listing not found")
        }
      }
      assertAssetReadyForStoryRoyaltyCommerce(asset, input.env)
      settlementMode = resolvePurchaseSettlementMode({
        storyRoyaltyRegistrationStatus: asset.story_royalty_registration_status,
        storyIpId: asset.story_ip_id,
      })
    } else if (listing.replay_asset_id?.trim()) {
      const replayAsset = await getLiveRoomReplayAssetById({
        client: db.client,
        communityId: input.communityId,
        replayAssetId: listing.replay_asset_id,
      })
      if (
        !replayAsset
        || replayAsset.publication_status !== "published"
        || replayAsset.access_mode !== "paid"
        || replayAsset.locked_delivery_status !== "ready"
      ) {
        throw notFoundError("Listing not found")
      }
      if (input.publicBuyer) {
        throw notFoundError("Listing not found")
      }
    } else if (input.publicBuyer) {
      throw notFoundError("Listing not found")
    }
    const moneyPolicy = await getCommunityMoneyPolicy({ env: input.env, communityId: input.communityId })
    const route = resolveRoutePolicy({ moneyPolicy, body: input.body })
    if (!route.eligible) {
      throw eligibilityFailed("Funding lane does not satisfy community money policy")
    }
    const pricingPolicy = await getCommunityPricingPolicy({ env: input.env, communityId: input.communityId })
    const buyerUser = input.userId ? await input.userRepository.getUserById(input.userId) : null
    const resolvedPrice = resolveRegionalPrice({
      listing: serializeListing(listing),
      pricingPolicy,
      buyer: buyerUser,
    })
    const quoteId = makeId("qte")
    const quotedAt = nowIso()
    const expiresAt = new Date(Date.now() + moneyPolicy.quote_ttl_seconds * 1000).toISOString()
    const verificationSnapshotRef = resolvedPrice.verificationSnapshot ? makeId("qvs") : null
    const listingPolicy = parseListingPolicy(listing)
    assertDonationsSupportedForListingTarget({
      assetId: listing.asset_id,
      liveRoomId: listing.live_room_id,
      replayAssetId: listing.replay_asset_id,
      donationPartnerId: listingPolicy.donationPartnerId,
    })

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

    if (listing.replay_asset_id?.trim()) {
      replayAllocationSnapshot = resolveReplayQuoteAllocationSnapshot({
        finalPriceUsd: resolvedPrice.finalPriceUsd,
        replayAllocations: await listLiveRoomReplayAllocations({
          client: db.client,
          communityId: input.communityId,
          replayAssetId: listing.replay_asset_id,
        }),
        listingPolicy,
      })
    }
    const allocationSnapshot = assertExecutableQuoteAllocationSnapshot(
      replayAllocationSnapshot ?? resolveQuoteAllocationSnapshot({
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
          quote_id, community_id, listing_id, buyer_kind, buyer_user_id,
          buyer_wallet_address, buyer_wallet_address_normalized, buyer_chain_ref,
          asset_id, live_room_id, replay_asset_id, base_price_usd,
          pricing_tier, final_price_usd, allocation_snapshot_json, funding_mode, funding_asset_json, source_chain_json,
          route_provider, funding_destination_address, route_policy_compliant, route_live_available, policy_origin,
          destination_settlement_chain_json, destination_settlement_token, destination_settlement_amount_atomic,
          destination_settlement_decimals, treasury_denomination,
          quote_ttl_seconds, route_required, route_status_policy, route_hop_tolerance,
          settlement_mode, verification_snapshot_ref, pricing_policy_version, status, quoted_at, expires_at,
          consumed_at, failed_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5,
          ?6, ?7, ?8,
          ?9, ?10, ?11, ?12,
          ?13, ?14, ?15, ?16, ?17, ?18, ?19,
          ?20, ?21, ?22, ?23, ?24, ?25,
          ?26, ?27, ?28, ?29, ?30, ?31,
          ?32, ?33, ?34, ?35, 'active', ?36, ?37,
          NULL, NULL, ?36, ?36
        )
      `,
      args: [
        quoteId,
        input.communityId,
        listing.listing_id,
        buyerFields.buyer_kind,
        buyerFields.buyer_user_id,
        buyerFields.buyer_wallet_address,
        buyerFields.buyer_wallet_address_normalized,
        buyerFields.buyer_chain_ref,
        listing.asset_id,
        listing.live_room_id,
        listing.replay_asset_id,
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
            verification_snapshot_ref, community_id, quote_id, buyer_kind, buyer_user_id,
            buyer_wallet_address, buyer_wallet_address_normalized, buyer_chain_ref,
            provider, nationality_state,
            nationality_value, pricing_tier, pricing_policy_version, snapshot_json, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, ?4, ?5,
            ?6, ?7, ?8,
            ?9, ?10,
            ?11, ?12, ?13, ?14, ?15, ?15
          )
        `,
        args: [
          verificationSnapshotRef,
          input.communityId,
          quoteId,
          buyerFields.buyer_kind,
          buyerFields.buyer_user_id,
          buyerFields.buyer_wallet_address,
          buyerFields.buyer_wallet_address_normalized,
          buyerFields.buyer_chain_ref,
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
    return quote
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
  const quote = await createCommunityPurchaseQuoteRowForBuyer({
    env: input.env,
    buyer: userBuyer(input.userId),
    userId: input.userId,
    communityId: input.communityId,
    body: input.body,
    communityRepository: input.communityRepository,
    userRepository: input.userRepository,
  })
  return serializeQuote(quote)
}

export async function createPublicCommunityPurchaseQuote(input: {
  env: Env
  buyer: BuyerIdentity
  communityId: string
  body: CommunityPurchaseQuoteRequest
  communityRepository: CommunityDatabaseBindingRepository
  userRepository: UserRepository
}): Promise<PublicCommunityPurchaseQuote> {
  const quote = await createCommunityPurchaseQuoteRowForBuyer({
    env: input.env,
    buyer: input.buyer,
    publicBuyer: true,
    communityId: input.communityId,
    body: input.body,
    communityRepository: input.communityRepository,
    userRepository: input.userRepository,
  })
  return serializePublicQuote(quote)
}

export async function failCommunityPurchase(input: {
  env: Env
  userId: string
  communityId: string
  body: CommunityPurchaseSettlementFailureRequest
  communityRepository: CommunityDatabaseBindingRepository
}): Promise<CommunityPurchaseSettlementFailure> {
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const quoteId = decodePublicId(input.body.quote, "pq")
    const quote = await getPurchaseQuoteRow(db.client, input.communityId, quoteId)
    if (!quote || !buyerMatchesFields(userBuyer(input.userId), quote)) {
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
      args: [input.communityId, quoteId, nextStatus, now],
    })
    return {
      id: `pur_${quote.quote_id}`,
      object: "community_purchase_settlement_failure",
      quote: `pq_${quote.quote_id}`,
      community: `com_${quote.community_id}`,
      status: nextStatus,
      failed_at: nextStatus === "failed" ? nullableUnixSeconds(now) : null,
      expires_at: unixSeconds(quote.expires_at),
    }
  } finally {
    db.close()
  }
}
