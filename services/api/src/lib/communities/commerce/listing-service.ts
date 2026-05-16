import { badRequestError, notFoundError } from "../../errors"
import { makeId, nowIso } from "../../helpers"
import { loadCommunityProjection } from "../create/service"
import {
  OWNER_OR_ADMIN_ROLE,
  canAccessCommunity,
  getCommunityMembershipState,
  hasCommunityRole,
} from "../membership/membership-state-store"
import { openCommunityDb } from "../community-db-factory"
import type {
  CommunityDatabaseBindingRepository,
  CommunityReadRepository,
} from "../db-community-repository"
import type { UserRepository } from "../../auth/repositories"
import type { Client } from "../../sql-client"
import {
  getAssetRow,
  getListingRowByAssetId,
  getListingRowByLiveRoomId,
  getListingRowById,
  listListingRows,
  parseListingPolicy,
  requireCommunityMember,
  requireVerifiedHuman,
  serializeListing,
} from "./shared"
import { centsToUsd } from "./serialization"
import { getCommunityPricingPolicy } from "./policy-service"
import { assertValidDonationSharePct } from "./quote-helpers"
import { assertAssetReadyForStoryRoyaltyCommerce } from "./story-royalty"
import { assertEndaomentPayoutConfigured } from "./endaoment-payout-service"
import {
  getLiveRoomListingTarget,
  resolveRequestedListingTarget,
} from "./listing-targets"
import {
  decodeCommerceListCursor,
  encodeCommerceListCursor,
} from "./list-cursors"
import type {
  CommunityListing,
  CommunityListingListResponse,
  CreateCommunityListingRequest,
  Env,
  UpdateCommunityListingRequest,
} from "../../../types"

type ListingDonationConfig = {
  donation_partner_id: string | null
  donation_share_pct: number | null
}

type CommunityListingRepository = CommunityReadRepository & CommunityDatabaseBindingRepository
type ListingExecutor = Pick<Client, "execute">

async function resolveListingDonationConfig(input: {
  env: Env
  communityId: string
  communityRepository: CommunityListingRepository
  current: ListingDonationConfig
  requestedPartnerId: string | null | undefined
  requestedShareBps: number | null | undefined
}): Promise<ListingDonationConfig> {
  const requestedSharePct = input.requestedShareBps == null ? input.requestedShareBps : input.requestedShareBps / 100
  const nextSharePct = requestedSharePct === undefined
    ? input.current.donation_share_pct
    : requestedSharePct
  const nextPartnerId = input.requestedPartnerId === undefined
    ? input.current.donation_partner_id
    : input.requestedPartnerId

  if (nextSharePct === 0) {
    return {
      donation_partner_id: null,
      donation_share_pct: null,
    }
  }

  if (nextSharePct == null) {
    if (typeof nextPartnerId === "string" && nextPartnerId.trim()) {
      throw badRequestError("donation_share_pct is required when donation_partner_id is set")
    }
    return {
      donation_partner_id: null,
      donation_share_pct: null,
    }
  }

  assertValidDonationSharePct(nextSharePct)

  if (!nextPartnerId?.trim()) {
    throw badRequestError("donation_partner_id is required when donation_share_pct is greater than 0")
  }

  const communityRow = await input.communityRepository.getCommunityById(input.communityId)
  if (!communityRow) {
    throw notFoundError("Community not found")
  }
  const community = await loadCommunityProjection(input.env, input.communityRepository, communityRow)
  if (community.donation_policy_mode === "none" || !community.donation_partner_id?.trim()) {
    throw badRequestError("Community charity is not configured")
  }
  if (community.donation_partner_id !== nextPartnerId.trim()) {
    throw badRequestError("Listing charity must match the community charity")
  }
  if (community.donation_partner?.provider === "endaoment") {
    try {
      assertEndaomentPayoutConfigured(input.env)
    } catch {
      throw badRequestError("Community charity payout provider is not available")
    }
  } else {
    throw badRequestError("Community charity provider is not supported")
  }

  return {
    donation_partner_id: nextPartnerId.trim(),
    donation_share_pct: nextSharePct,
  }
}

async function assertRegionalPricingEnabledIfRequested(input: {
  env: Env
  communityId: string
  requested: boolean | null | undefined
}): Promise<void> {
  if (!input.requested) {
    return
  }
  const pricingPolicy = await getCommunityPricingPolicy({ env: input.env, communityId: input.communityId })
  if (!pricingPolicy.regional_pricing_enabled) {
    throw badRequestError("Community regional pricing is not enabled")
  }
}

export async function listCommunityListings(input: {
  env: Env
  userId: string
  communityId: string
  communityRepository: CommunityListingRepository
  cursor?: string | null
  limit: number
}): Promise<CommunityListingListResponse> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const rows = await listListingRows(db.client, input.communityId, {
      after: decodeCommerceListCursor(input.cursor),
      limit: input.limit + 1,
    })
    const pageRows = rows.slice(0, input.limit)
    const lastRow = pageRows[pageRows.length - 1] ?? null
    return {
      items: pageRows.map((row) => serializeListing(row)),
      next_cursor: rows.length > input.limit && lastRow
        ? encodeCommerceListCursor({ created_at: lastRow.created_at, id: lastRow.listing_id })
        : null,
    }
  } finally {
    db.close()
  }
}

export async function createCommunityListingInTransaction(input: {
  env: Env
  userId: string
  communityId: string
  body: CreateCommunityListingRequest
  communityRepository: CommunityListingRepository
  userRepository: UserRepository
  client: ListingExecutor
}): Promise<CommunityListing> {
  const { assetId, liveRoomId } = resolveRequestedListingTarget(input.body)
  const membership = await getCommunityMembershipState(input.client, input.communityId, input.userId)
  if (!canAccessCommunity(membership)) {
    throw notFoundError("Community not found")
  }
  await requireVerifiedHuman(input.userRepository, input.userId, {
    bypassForCommunityOwner: hasCommunityRole(membership, OWNER_OR_ADMIN_ROLE),
  })
  if (assetId) {
    const asset = await getAssetRow(input.client, input.communityId, assetId)
    if (!asset) {
      throw notFoundError("Asset not found")
    }
    assertAssetReadyForStoryRoyaltyCommerce(asset, input.env)
    if (asset.creator_user_id !== input.userId && !hasCommunityRole(membership, OWNER_OR_ADMIN_ROLE)) {
      throw notFoundError("Asset not found")
    }
    if (await getListingRowByAssetId(input.client, input.communityId, assetId)) {
      throw badRequestError("Asset already has a listing")
    }
  } else if (liveRoomId) {
    const liveRoom = await getLiveRoomListingTarget(input.client, input.communityId, liveRoomId)
    if (!liveRoom) {
      throw notFoundError("Live room not found")
    }
    if (liveRoom.host_user_id !== input.userId && !hasCommunityRole(membership, OWNER_OR_ADMIN_ROLE)) {
      throw notFoundError("Live room not found")
    }
    if (await getListingRowByLiveRoomId(input.client, input.communityId, liveRoomId)) {
      throw badRequestError("Live room already has a listing")
    }
  }
  await assertRegionalPricingEnabledIfRequested({
    env: input.env,
    communityId: input.communityId,
    requested: input.body.regional_pricing_enabled,
  })
  const donationConfig = await resolveListingDonationConfig({
    env: input.env,
    communityId: input.communityId,
    communityRepository: input.communityRepository,
    current: {
      donation_partner_id: null,
      donation_share_pct: null,
    },
    requestedPartnerId: input.body.donation_partner,
    requestedShareBps: input.body.donation_share_bps,
  })
  const listingId = makeId("lst")
  const createdAt = nowIso()
  await input.client.execute({
    sql: `
      INSERT INTO listings (
        listing_id, community_id, asset_id, live_room_id, listing_mode, status, price_usd,
        regional_pricing_policy_json, created_by_user_id, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, 'fixed_price', ?5, ?6,
        ?7, ?8, ?9, ?9
      )
    `,
    args: [
      listingId,
      input.communityId,
      assetId,
      liveRoomId,
      input.body.status,
      centsToUsd(input.body.price_cents),
      JSON.stringify({
        regional_pricing_enabled: input.body.regional_pricing_enabled,
        donation_partner_id: donationConfig.donation_partner_id,
        donation_share_pct: donationConfig.donation_share_pct,
      }),
      input.userId,
      createdAt,
    ],
  })
  const listing = await getListingRowById(input.client, input.communityId, listingId)
  if (!listing) {
    throw notFoundError("Listing not found")
  }
  return serializeListing(listing)
}

export async function createCommunityListing(input: {
  env: Env
  userId: string
  communityId: string
  body: CreateCommunityListingRequest
  communityRepository: CommunityListingRepository
  userRepository: UserRepository
}): Promise<CommunityListing> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    return await createCommunityListingInTransaction({
      ...input,
      client: db.client,
    })
  } finally {
    db.close()
  }
}

export async function updateCommunityListing(input: {
  env: Env
  userId: string
  communityId: string
  listingId: string
  body: UpdateCommunityListingRequest
  communityRepository: CommunityListingRepository
}): Promise<CommunityListing> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const listing = await getListingRowById(db.client, input.communityId, input.listingId)
    if (!listing) {
      throw notFoundError("Listing not found")
    }
    if (listing.created_by_user_id !== input.userId) {
      const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
      if (!hasCommunityRole(membership, OWNER_OR_ADMIN_ROLE)) {
        throw notFoundError("Listing not found")
      }
    }
    if (listing.asset_id?.trim() && (input.body.status ?? listing.status) === "active") {
      const asset = await getAssetRow(db.client, input.communityId, listing.asset_id)
      if (!asset) {
        throw notFoundError("Asset not found")
      }
      assertAssetReadyForStoryRoyaltyCommerce(asset, input.env)
    }
    const currentPolicy = parseListingPolicy(listing)
    const nextRegional = input.body.regional_pricing_enabled
      ?? currentPolicy.regionalPricingEnabled
    const donationConfig = await resolveListingDonationConfig({
      env: input.env,
      communityId: input.communityId,
      communityRepository: input.communityRepository,
      current: {
        donation_partner_id: currentPolicy.donationPartnerId,
        donation_share_pct: currentPolicy.donationSharePct,
      },
      requestedPartnerId: input.body.donation_partner,
      requestedShareBps: input.body.donation_share_bps,
    })
    await assertRegionalPricingEnabledIfRequested({
      env: input.env,
      communityId: input.communityId,
      requested: nextRegional,
    })
    await db.client.execute({
      sql: `
        UPDATE listings
        SET status = ?3,
            price_usd = ?4,
            regional_pricing_policy_json = ?5,
            updated_at = ?6
        WHERE community_id = ?1
          AND listing_id = ?2
      `,
      args: [
        input.communityId,
        input.listingId,
        input.body.status ?? listing.status,
        input.body.price_cents == null ? listing.price_usd : centsToUsd(input.body.price_cents),
        JSON.stringify({
          regional_pricing_enabled: nextRegional,
          donation_partner_id: donationConfig.donation_partner_id,
          donation_share_pct: donationConfig.donation_share_pct,
        }),
        nowIso(),
      ],
    })
    const updated = await getListingRowById(db.client, input.communityId, input.listingId)
    if (!updated) {
      throw notFoundError("Listing not found")
    }
    return serializeListing(updated)
  } finally {
    db.close()
  }
}

export async function getCommunityListing(input: {
  env: Env
  userId: string
  communityId: string
  listingId: string
  communityRepository: CommunityListingRepository
}): Promise<CommunityListing> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const listing = await getListingRowById(db.client, input.communityId, input.listingId)
    if (!listing) {
      throw notFoundError("Listing not found")
    }
    return serializeListing(listing)
  } finally {
    db.close()
  }
}
