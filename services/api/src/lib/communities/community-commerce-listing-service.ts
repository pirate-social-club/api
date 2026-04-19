import { badRequestError, notFoundError } from "../errors"
import { makeId, nowIso } from "../helpers"
import { getCommunityMembershipState } from "./community-membership-store"
import { openCommunityDb } from "./community-db-factory"
import type { CommunityRepository } from "./db-community-repository"
import type { UserRepository } from "../auth/repositories"
import {
  getAssetRow,
  getListingRowByAssetId,
  getListingRowById,
  listListingRows,
  parseJsonValue,
  requireCommunityMember,
  requireVerifiedHuman,
  serializeListing,
} from "./community-commerce-shared"
import { getCommunityPricingPolicy } from "./community-commerce-policy-service"
import type {
  CommunityListing,
  CommunityListingListResponse,
  CreateCommunityListingRequest,
  Env,
  UpdateCommunityListingRequest,
} from "../../types"

export async function listCommunityListings(input: {
  env: Env
  userId: string
  communityId: string
  communityRepository: CommunityRepository
}): Promise<CommunityListingListResponse> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    return {
      items: (await listListingRows(db.client, input.communityId)).map((row) => serializeListing(row)),
    }
  } finally {
    db.close()
  }
}

export async function createCommunityListing(input: {
  env: Env
  userId: string
  communityId: string
  body: CreateCommunityListingRequest
  communityRepository: CommunityRepository
  userRepository: UserRepository
}): Promise<CommunityListing> {
  if (!input.body.asset_id?.trim() && !input.body.live_room_id?.trim()) {
    throw badRequestError("asset_id or live_room_id is required")
  }
  await requireVerifiedHuman(input.userRepository, input.userId)
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    if (input.body.asset_id?.trim()) {
      const asset = await getAssetRow(db.client, input.communityId, input.body.asset_id)
      if (!asset) {
        throw notFoundError("Asset not found")
      }
      if (asset.creator_user_id !== input.userId) {
        const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
        if (membership.role_status !== "active") {
          throw notFoundError("Asset not found")
        }
      }
      if (await getListingRowByAssetId(db.client, input.communityId, input.body.asset_id)) {
        throw badRequestError("Asset already has a listing")
      }
      const pricingPolicy = await getCommunityPricingPolicy({ env: input.env, communityId: input.communityId })
      if (input.body.regional_pricing_enabled && !pricingPolicy.regional_pricing_enabled) {
        throw badRequestError("Community regional pricing is not enabled")
      }
    }
    const listingId = makeId("lst")
    const createdAt = nowIso()
    await db.client.execute({
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
        input.body.asset_id ?? null,
        input.body.live_room_id ?? null,
        input.body.status,
        input.body.price_usd,
        JSON.stringify({ regional_pricing_enabled: input.body.regional_pricing_enabled }),
        input.userId,
        createdAt,
      ],
    })
    const listing = await getListingRowById(db.client, input.communityId, listingId)
    if (!listing) {
      throw notFoundError("Listing not found")
    }
    return serializeListing(listing)
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
  communityRepository: CommunityRepository
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
      if (membership.role_status !== "active") {
        throw notFoundError("Listing not found")
      }
    }
    const nextRegional = input.body.regional_pricing_enabled
      ?? parseJsonValue<{ regional_pricing_enabled?: boolean }>(listing.regional_pricing_policy_json, {}).regional_pricing_enabled
      ?? false
    if (nextRegional) {
      const pricingPolicy = await getCommunityPricingPolicy({ env: input.env, communityId: input.communityId })
      if (!pricingPolicy.regional_pricing_enabled) {
        throw badRequestError("Community regional pricing is not enabled")
      }
    }
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
        input.body.price_usd ?? listing.price_usd,
        JSON.stringify({
          regional_pricing_enabled: nextRegional,
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
  communityRepository: CommunityRepository
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
