import { badRequestError, notFoundError } from "../../errors"
import { makeId, nowIso } from "../../helpers"
import { loadCommunityProjection } from "../create/service"
import {
  OWNER_OR_ADMIN_ROLE,
  canAccessCommunity,
  getCommunityMembershipState,
  hasCommunityRole,
} from "../membership/membership-state-store"
import { openCommunityReadClient, openCommunityWriteClient } from "../community-read-access"
import { requireLiveCommunity } from "../community-status"
import type {
  CommunityDatabaseBindingRepository,
  CommunityReadRepository,
} from "../db-community-repository"
import type { UserRepository } from "../../auth/repositories"
import type { Client } from "../../sql-client"
import { executeFirst } from "../../db-helpers"
import { stringOrNull } from "./row-types"
import { assertSongRightsInvariant } from "../../posts/song-rights-invariant"
import {
  getAssetRow,
  getListingRowByAssetId,
  getListingRowByLiveRoomId,
  getListingRowByReplayAssetId,
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
import {
  assertAssetNotRightsHeld,
  assertListingNotRightsHeld,
} from "./rights-hold-gates"
import { assertEndaomentPayoutConfigured } from "./endaoment-payout-service"
import { excludeKnownZeroRevenueShareStoryParents } from "./derivative-parent-revenue-share"
import { parseJsonValue } from "./row-types"
import {
  getReplayAssetListingTarget,
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

type ListingVinylReleaseConfig = {
  vinyl_release_provider: CommunityListing["vinyl_release_provider"] | null
  vinyl_release_url: string | null
}

type CommunityListingRepository = CommunityReadRepository & CommunityDatabaseBindingRepository
type ListingExecutor = Pick<Client, "execute">
type ListingAssetKind = NonNullable<Awaited<ReturnType<typeof getAssetRow>>>["asset_kind"]

async function assertDerivativeParentsReadyForListing(input: {
  env: Env
  asset: NonNullable<Awaited<ReturnType<typeof getAssetRow>>>
}): Promise<void> {
  const parentIpIds = parseJsonValue<string[]>(input.asset.story_derivative_parent_ip_ids_json, [])
    .filter((parentIpId) => typeof parentIpId === "string" && parentIpId.trim())
    .map((parentIpId) => parentIpId.trim())
  const payableParentIpIds = await excludeKnownZeroRevenueShareStoryParents({
    env: input.env,
    parentIpIds,
  })
  if (payableParentIpIds.length !== parentIpIds.length) {
    throw badRequestError("Derivative sources must have a positive commercial revenue share")
  }
}

function parseUpstreamAssetRefs(value: string | null): string[] {
  if (!value) return []
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : []
  } catch {
    return []
  }
}

export async function assertSongAssetRightsReadyForListing(input: {
  client: ListingExecutor
  communityId: string
  asset: NonNullable<Awaited<ReturnType<typeof getAssetRow>>>
}): Promise<void> {
  if (input.asset.asset_kind !== "song_audio") return

  const sourcePost = await executeFirst(input.client, {
    sql: `
      SELECT song_mode, rights_basis, upstream_asset_refs_json
      FROM posts
      WHERE community_id = ?1 AND post_id = ?2 AND post_type = 'song'
      LIMIT 1
    `,
    args: [input.communityId, input.asset.source_post_id],
  })
  if (!sourcePost) {
    throw badRequestError("Song asset source post is unavailable for rights validation")
  }
  assertSongRightsInvariant({
    songMode: stringOrNull(sourcePost, "song_mode"),
    rightsBasis: stringOrNull(sourcePost, "rights_basis"),
    upstreamAssetRefs: parseUpstreamAssetRefs(stringOrNull(sourcePost, "upstream_asset_refs_json")),
  })
}

function resolveListingVinylReleaseConfig(input: {
  assetKind?: ListingAssetKind | "live_room" | null
  provider: CreateCommunityListingRequest["vinyl_release_provider"] | null | undefined
  url: string | null | undefined
}): ListingVinylReleaseConfig {
  const provider = input.provider?.trim() || null
  const url = input.url?.trim() || null

  if (!provider && !url) {
    return {
      vinyl_release_provider: null,
      vinyl_release_url: null,
    }
  }

  if (input.assetKind !== "song_audio") {
    throw badRequestError("Vinyl releases are only available for song listings")
  }
  if (provider !== "elasticstage") {
    throw badRequestError("Unsupported vinyl release provider")
  }
  if (!url) {
    throw badRequestError("vinyl_release_url is required when vinyl_release_provider is set")
  }

  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    throw badRequestError("vinyl_release_url must be a valid URL")
  }
  if (parsedUrl.protocol !== "https:") {
    throw badRequestError("vinyl_release_url must be an HTTPS URL")
  }

  return {
    vinyl_release_provider: provider,
    vinyl_release_url: url,
  }
}

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

function assertListingDonationsSupportedForTarget(input: {
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
    throw badRequestError("Live-room ticket donations are not supported until charity payout routing is enabled")
  }
  if (input.replayAssetId?.trim()) {
    throw badRequestError("Replay donations are not supported until charity payout routing is enabled")
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
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
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

/**
 * The fully resolved column values for a `listings` INSERT, plus the resolved
 * target. Produced by `prepareCommunityListingWrite` (all reads/validation) so
 * that `insertCommunityListingRow` can run as a pure, read-free write — safe
 * inside a buffered D1 `transaction("write")` (which sends every statement to
 * one atomic shard `batchWrite` where SELECTs are rejected).
 */
type PreparedCommunityListingWrite = {
  listingId: string
  createdAt: string
  assetId: string | null
  liveRoomId: string | null
  replayAssetId: string | null
  status: CreateCommunityListingRequest["status"]
  priceUsd: number
  regionalPricingPolicyJson: string
  vinylReleaseProvider: ListingVinylReleaseConfig["vinyl_release_provider"]
  vinylReleaseUrl: string | null
  createdByUserId: string
}

/**
 * Validate a listing request and resolve every column value, doing ALL the
 * reads (membership, target asset/live-room, duplicate-listing checks) up front
 * on a read-capable client. MUST run BEFORE opening a write transaction when the
 * write goes through the routed D1 buffering client — those reads cannot run
 * inside the buffered batch.
 *
 * `liveRoomTarget: "create-in-tx"` is the live-room-publish case: the target
 * live room is created in the SAME write tx (so it can't be read here yet) and
 * is known-good by construction — host = the requesting user, brand new, no
 * possible prior listing — so the per-room reads are skipped. The room's id is
 * supplied to `insertCommunityListingRow` after it is created.
 */
export async function prepareCommunityListingWrite(input: {
  env: Env
  userId: string
  communityId: string
  body: CreateCommunityListingRequest
  communityRepository: CommunityListingRepository
  userRepository: UserRepository
  client: ListingExecutor
  liveRoomTarget?: "validate" | "create-in-tx"
}): Promise<PreparedCommunityListingWrite> {
  const creatingLiveRoomInTx = input.liveRoomTarget === "create-in-tx"
  let assetId: string | null = null
  let liveRoomId: string | null = null
  let replayAssetId: string | null = null
  let assetKind: ListingAssetKind | "live_room" | null = null
  if (creatingLiveRoomInTx) {
    assetKind = "live_room"
  } else {
    const target = resolveRequestedListingTarget(input.body)
    assetId = target.assetId
    liveRoomId = target.liveRoomId
    replayAssetId = target.replayAssetId
  }

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
    assetKind = asset.asset_kind
    await assertSongAssetRightsReadyForListing({
      client: input.client,
      communityId: input.communityId,
      asset,
    })
    assertAssetReadyForStoryRoyaltyCommerce(asset, input.env)
    await assertDerivativeParentsReadyForListing({ env: input.env, asset })
    await assertAssetNotRightsHeld({
      client: input.client,
      communityId: input.communityId,
      asset,
    })
    if (asset.creator_user_id !== input.userId && !hasCommunityRole(membership, OWNER_OR_ADMIN_ROLE)) {
      throw notFoundError("Asset not found")
    }
    if (await getListingRowByAssetId(input.client, input.communityId, assetId)) {
      throw badRequestError("Asset already has a listing")
    }
  } else if (liveRoomId) {
    assetKind = "live_room"
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
  } else if (replayAssetId) {
    assetKind = "live_room"
    const replayAsset = await getReplayAssetListingTarget(input.client, input.communityId, replayAssetId)
    if (!replayAsset) {
      throw notFoundError("Replay asset not found")
    }
    if (replayAsset.host_user_id !== input.userId && !hasCommunityRole(membership, OWNER_OR_ADMIN_ROLE)) {
      throw notFoundError("Replay asset not found")
    }
    if (await getListingRowByReplayAssetId(input.client, input.communityId, replayAssetId)) {
      throw badRequestError("Replay asset already has a listing")
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
  assertListingDonationsSupportedForTarget({
    assetId,
    liveRoomId: creatingLiveRoomInTx ? "create-in-tx" : liveRoomId,
    replayAssetId,
    donationPartnerId: donationConfig.donation_partner_id,
  })
  const vinylReleaseConfig = resolveListingVinylReleaseConfig({
    assetKind,
    provider: input.body.vinyl_release_provider,
    url: input.body.vinyl_release_url,
  })
  return {
    listingId: makeId("lst"),
    createdAt: nowIso(),
    assetId,
    liveRoomId,
    replayAssetId,
    status: input.body.status,
    priceUsd: centsToUsd(input.body.price_cents),
    regionalPricingPolicyJson: JSON.stringify({
      regional_pricing_enabled: input.body.regional_pricing_enabled,
      donation_partner_id: donationConfig.donation_partner_id,
      donation_share_pct: donationConfig.donation_share_pct,
    }),
    vinylReleaseProvider: vinylReleaseConfig.vinyl_release_provider,
    vinylReleaseUrl: vinylReleaseConfig.vinyl_release_url,
    createdByUserId: input.userId,
  }
}

/**
 * Write-only INSERT of a prepared listing. No reads — safe inside a buffered D1
 * write tx. `liveRoomIdOverride` supplies the live-room target when it is created
 * in the same tx (its id is unknown at `prepareCommunityListingWrite` time).
 */
export async function insertCommunityListingRow(
  client: ListingExecutor,
  communityId: string,
  prepared: PreparedCommunityListingWrite,
  liveRoomIdOverride?: string,
): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO listings (
        listing_id, community_id, asset_id, live_room_id, replay_asset_id, listing_mode, status, price_usd,
        regional_pricing_policy_json, vinyl_release_provider, vinyl_release_url,
        created_by_user_id, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, 'fixed_price', ?6, ?7,
        ?8, ?9, ?10, ?11, ?12, ?12
      )
    `,
    args: [
      prepared.listingId,
      communityId,
      prepared.assetId,
      liveRoomIdOverride ?? prepared.liveRoomId,
      prepared.replayAssetId,
      prepared.status,
      prepared.priceUsd,
      prepared.regionalPricingPolicyJson,
      prepared.vinylReleaseProvider,
      prepared.vinylReleaseUrl,
      prepared.createdByUserId,
      prepared.createdAt,
    ],
  })
}

/** Hydrate a freshly written listing into its API shape. Read — run on a
 * read-capable client (post-commit when the write went through a buffered tx). */
export async function hydrateCommunityListing(
  client: ListingExecutor,
  communityId: string,
  listingId: string,
): Promise<CommunityListing> {
  const listing = await getListingRowById(client, communityId, listingId)
  if (!listing) {
    throw notFoundError("Listing not found")
  }
  return serializeListing(listing)
}

/**
 * Shared listing-creation transaction body. Runs inside an already-open shard write tx and
 * does NOT validate community lifecycle status — callers MUST guard with requireLiveCommunity
 * (or equivalent) at their entry point before opening the write client. Current callers:
 * createCommunityListing and live-rooms publishLiveRoom, both of which guard upstream.
 */
export async function createCommunityListingInTransaction(input: {
  env: Env
  userId: string
  communityId: string
  body: CreateCommunityListingRequest
  communityRepository: CommunityListingRepository
  userRepository: UserRepository
  client: ListingExecutor
}): Promise<CommunityListing> {
  const prepared = await prepareCommunityListingWrite(input)
  await insertCommunityListingRow(input.client, input.communityId, prepared)
  return hydrateCommunityListing(input.client, input.communityId, prepared.listingId)
}

export async function createCommunityListing(input: {
  env: Env
  userId: string
  communityId: string
  body: CreateCommunityListingRequest
  communityRepository: CommunityListingRepository
  userRepository: UserRepository
}): Promise<CommunityListing> {
  await requireLiveCommunity(input.communityRepository, input.communityId)
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
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
  const db = await openCommunityWriteClient(input.env, input.communityRepository, input.communityId)
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
      await assertSongAssetRightsReadyForListing({
        client: db.client,
        communityId: input.communityId,
        asset,
      })
      await assertAssetNotRightsHeld({
        client: db.client,
        communityId: input.communityId,
        asset,
      })
      assertAssetReadyForStoryRoyaltyCommerce(asset, input.env)
      await assertDerivativeParentsReadyForListing({ env: input.env, asset })
    } else if ((input.body.status ?? listing.status) === "active") {
      await assertListingNotRightsHeld({
        client: db.client,
        communityId: input.communityId,
        listing,
      })
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
    assertListingDonationsSupportedForTarget({
      assetId: listing.asset_id,
      liveRoomId: listing.live_room_id,
      replayAssetId: listing.replay_asset_id,
      donationPartnerId: donationConfig.donation_partner_id,
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
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
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
