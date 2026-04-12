import type {
  CommunityListing as CommunityListingApi,
  CommunityListingListResponse,
  CommunityPurchase,
  CommunityPurchaseListResponse,
  CreateCommunityListingRequest,
  Env,
  UpdateCommunityListingRequest,
} from "../../types"
import { verifyPirateAccessToken } from "../auth/pirate-session-token"
import { badRequestError, notFoundError } from "../errors"
import { makeId, nowIso } from "../helpers"
import { assertNonEmptyString, assertNonNegativeNumber, assertNullableString, isRecord } from "../validation"
import { openCommunityDb } from "./community-db-factory"
import type { CommunityRepository } from "./control-plane-community-repository"
import {
  createCommunityListing,
  getCommunityListingById,
  listCommunityListings,
  updateCommunityListing,
} from "./community-listing-store"
import { getCommunityPurchaseById, listCommunityPurchasesByBuyer } from "./community-purchase-store"

function assertCreateCommunityListingRequest(value: unknown): asserts value is CreateCommunityListingRequest {
  if (!isRecord(value)) {
    throw badRequestError("Invalid community listing payload")
  }
  assertNullableString(value.asset_id, "asset_id")
  assertNullableString(value.live_room_id, "live_room_id")
  assertNonNegativeNumber(value.price_usd, "price_usd")
  if (typeof value.regional_pricing_enabled !== "boolean") {
    throw badRequestError("regional_pricing_enabled must be a boolean")
  }
  if (
    value.status !== "draft"
    && value.status !== "active"
    && value.status !== "paused"
    && value.status !== "archived"
  ) {
    throw badRequestError("status must be one of draft, active, paused, archived")
  }
  const hasAsset = typeof value.asset_id === "string" && value.asset_id.trim().length > 0
  const hasLiveRoom = typeof value.live_room_id === "string" && value.live_room_id.trim().length > 0
  if ((hasAsset && hasLiveRoom) || (!hasAsset && !hasLiveRoom)) {
    throw badRequestError("Exactly one of asset_id or live_room_id is required")
  }
}

function assertUpdateCommunityListingRequest(value: unknown): asserts value is UpdateCommunityListingRequest {
  if (!isRecord(value)) {
    throw badRequestError("Invalid community listing update payload")
  }
  if (value.price_usd === undefined && value.status === undefined && value.regional_pricing_enabled === undefined) {
    throw badRequestError("At least one listing field must be provided")
  }
  if (value.price_usd !== undefined) {
    assertNonNegativeNumber(value.price_usd, "price_usd")
  }
  if (
    value.status !== undefined
    && value.status !== "draft"
    && value.status !== "active"
    && value.status !== "paused"
    && value.status !== "archived"
  ) {
    throw badRequestError("status must be one of draft, active, paused, archived")
  }
  if (value.regional_pricing_enabled !== undefined && typeof value.regional_pricing_enabled !== "boolean") {
    throw badRequestError("regional_pricing_enabled must be a boolean")
  }
}

async function requireOwnedCommunity(
  repository: CommunityRepository,
  communityId: string,
  userId: string,
): Promise<void> {
  const community = await repository.getCommunityById(communityId)
  if (!community || community.creator_user_id !== userId || community.status !== "active" || community.provisioning_state !== "active") {
    throw notFoundError("Community not found")
  }
}

function serializeListing(listing: Awaited<ReturnType<typeof getCommunityListingById>>): CommunityListingApi {
  return {
    listing_id: listing.listing_id,
    community_id: listing.community_id,
    asset_id: listing.asset_id,
    live_room_id: listing.live_room_id,
    listing_mode: listing.listing_mode,
    status: listing.status,
    price_usd: listing.price_usd,
    regional_pricing_enabled: listing.regional_pricing_policy?.enabled === true,
    created_by_user_id: listing.created_by_user_id,
    created_at: listing.created_at,
    updated_at: listing.updated_at,
  }
}

function serializePurchase(purchase: Awaited<ReturnType<typeof getCommunityPurchaseById>> extends infer T ? Exclude<T, null> : never): CommunityPurchase {
  return {
    purchase_id: purchase.purchase_id,
    community_id: purchase.community_id,
    listing_id: purchase.listing_id,
    asset_id: purchase.asset_id,
    live_room_id: purchase.live_room_id,
    buyer_user_id: purchase.buyer_user_id,
    settlement_wallet_attachment_id: purchase.settlement_wallet_attachment_id,
    purchase_price_usd: purchase.purchase_price_usd,
    pricing_tier: purchase.pricing_tier,
    settlement_chain: purchase.settlement_chain,
    settlement_token: purchase.settlement_token,
    settlement_tx_ref: purchase.settlement_tx_ref,
    purchase_entitlement_id: purchase.purchase_entitlement_id,
    entitlement_kind: purchase.entitlement_kind,
    entitlement_target_ref: purchase.entitlement_target_ref,
    created_at: purchase.created_at,
  }
}

export async function createCommunityListingRecord(input: {
  env: Env
  bearerToken: string
  communityId: string
  body: unknown
  repository: CommunityRepository
}): Promise<CommunityListingApi> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  assertCreateCommunityListingRequest(input.body)
  await requireOwnedCommunity(input.repository, input.communityId, session.userId)

  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const listing = await createCommunityListing({
      client: db.client,
      listingId: makeId("lst"),
      communityId: input.communityId,
      assetId: input.body.asset_id?.trim() ?? null,
      liveRoomId: input.body.live_room_id?.trim() ?? null,
      status: input.body.status,
      priceUsd: input.body.price_usd,
      regionalPricingEnabled: input.body.regional_pricing_enabled,
      createdByUserId: session.userId,
      now: nowIso(),
    })
    return serializeListing(listing)
  } finally {
    db.close()
  }
}

export async function listCommunityListingRecords(input: {
  env: Env
  bearerToken: string
  communityId: string
  repository: CommunityRepository
}): Promise<CommunityListingListResponse> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  await requireOwnedCommunity(input.repository, input.communityId, session.userId)

  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const items = await listCommunityListings({
      client: db.client,
      communityId: input.communityId,
    })
    return {
      items: items.map(serializeListing),
    }
  } finally {
    db.close()
  }
}

export async function getCommunityListingRecord(input: {
  env: Env
  bearerToken: string
  communityId: string
  listingId: string
  repository: CommunityRepository
}): Promise<CommunityListingApi> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  await requireOwnedCommunity(input.repository, input.communityId, session.userId)

  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const listing = await getCommunityListingById({
      client: db.client,
      communityId: input.communityId,
      listingId: input.listingId,
    })
    return serializeListing(listing)
  } finally {
    db.close()
  }
}

export async function updateCommunityListingRecord(input: {
  env: Env
  bearerToken: string
  communityId: string
  listingId: string
  body: unknown
  repository: CommunityRepository
}): Promise<CommunityListingApi> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  assertUpdateCommunityListingRequest(input.body)
  await requireOwnedCommunity(input.repository, input.communityId, session.userId)

  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const listing = await updateCommunityListing({
      client: db.client,
      communityId: input.communityId,
      listingId: input.listingId,
      priceUsd: input.body.price_usd,
      status: input.body.status,
      regionalPricingEnabled: input.body.regional_pricing_enabled,
      now: nowIso(),
    })
    return serializeListing(listing)
  } finally {
    db.close()
  }
}

export async function listBuyerCommunityPurchases(input: {
  env: Env
  bearerToken: string
  communityId: string
  repository: CommunityRepository
}): Promise<CommunityPurchaseListResponse> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const items = await listCommunityPurchasesByBuyer({
      client: db.client,
      communityId: input.communityId,
      buyerUserId: session.userId,
    })
    return { items: items.map(serializePurchase) }
  } finally {
    db.close()
  }
}

export async function getBuyerCommunityPurchase(input: {
  env: Env
  bearerToken: string
  communityId: string
  purchaseId: string
  repository: CommunityRepository
}): Promise<CommunityPurchase> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.bearerToken })
  const db = await openCommunityDb(input.repository, input.communityId)
  try {
    const purchase = await getCommunityPurchaseById({
      client: db.client,
      communityId: input.communityId,
      purchaseId: input.purchaseId,
    })
    if (!purchase || purchase.buyer_user_id !== session.userId) {
      throw notFoundError("Purchase not found")
    }
    return serializePurchase(purchase)
  } finally {
    db.close()
  }
}
