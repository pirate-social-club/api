import type { Client, Transaction } from "@libsql/client"
import { badRequestError, notFoundError } from "../errors"

type ListingExecutor = Pick<Client, "execute"> | Pick<Transaction, "execute">
import { numberOrNull, requiredString, rowValue, stringOrNull } from "../sql-row"

export type CommunityListingRegionalPricingPolicy = {
  enabled: boolean
  policy_scope: "community_active"
}

export type CommunityListing = {
  listing_id: string
  community_id: string
  asset_id: string | null
  live_room_id: string | null
  listing_mode: "fixed_price"
  status: "draft" | "active" | "paused" | "archived"
  price_usd: number
  regional_pricing_policy: CommunityListingRegionalPricingPolicy | null
  created_by_user_id: string
  created_at: string
  updated_at: string
}

function parseRegionalPricingPolicy(value: unknown): CommunityListingRegionalPricingPolicy | null {
  const raw = stringOrNull(value)
  if (raw == null) {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw badRequestError("Stored listing regional pricing policy is invalid")
  }

  if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
    throw badRequestError("Stored listing regional pricing policy is invalid")
  }

  const policy = parsed as Record<string, unknown>
  if (typeof policy.enabled !== "boolean" || policy.policy_scope !== "community_active") {
    throw badRequestError("Stored listing regional pricing policy is invalid")
  }

  return {
    enabled: policy.enabled,
    policy_scope: "community_active",
  }
}

function toCommunityListing(row: unknown): CommunityListing {
  const priceUsd = numberOrNull(rowValue(row, "price_usd"))
  if (priceUsd == null || priceUsd < 0) {
    throw badRequestError("Stored listing price is invalid")
  }

  return {
    listing_id: requiredString(row, "listing_id"),
    community_id: requiredString(row, "community_id"),
    asset_id: stringOrNull(rowValue(row, "asset_id")),
    live_room_id: stringOrNull(rowValue(row, "live_room_id")),
    listing_mode: requiredString(row, "listing_mode") as CommunityListing["listing_mode"],
    status: requiredString(row, "status") as CommunityListing["status"],
    price_usd: priceUsd,
    regional_pricing_policy: parseRegionalPricingPolicy(rowValue(row, "regional_pricing_policy_json")),
    created_by_user_id: requiredString(row, "created_by_user_id"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export async function getCommunityListingById(input: {
  client: Client
  communityId: string
  listingId: string
}): Promise<CommunityListing> {
  const result = await input.client.execute({
    sql: `
      SELECT listing_id, community_id, asset_id, live_room_id, listing_mode, status, price_usd,
             regional_pricing_policy_json,
             created_by_user_id, created_at, updated_at
      FROM listings
      WHERE community_id = ?1
        AND listing_id = ?2
      LIMIT 1
    `,
    args: [input.communityId, input.listingId],
  })

  const row = result.rows[0]
  if (!row) {
    throw notFoundError("Listing not found")
  }

  return toCommunityListing(row)
}

export async function listCommunityListings(input: {
  client: Client
  communityId: string
}): Promise<CommunityListing[]> {
  const result = await input.client.execute({
    sql: `
      SELECT listing_id, community_id, asset_id, live_room_id, listing_mode, status, price_usd,
             regional_pricing_policy_json,
             created_by_user_id, created_at, updated_at
      FROM listings
      WHERE community_id = ?1
      ORDER BY created_at DESC, listing_id DESC
    `,
    args: [input.communityId],
  })

  return result.rows.map((row) => toCommunityListing(row))
}

export async function createCommunityListing(input: {
  client: ListingExecutor
  listingId: string
  communityId: string
  assetId: string | null
  liveRoomId: string | null
  status: CommunityListing["status"]
  priceUsd: number
  regionalPricingEnabled: boolean
  createdByUserId: string
  now: string
}): Promise<CommunityListing> {
  const regionalPricingPolicyJson = input.regionalPricingEnabled
    ? JSON.stringify({ enabled: true, policy_scope: "community_active" })
    : null

  await input.client.execute({
    sql: `
      INSERT INTO listings (
        listing_id, community_id, asset_id, live_room_id, listing_mode, status, price_usd,
        regional_pricing_policy_json, donation_enabled, donation_partner_id_snapshot,
        donation_share_pct, created_by_user_id, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, 'fixed_price', ?5, ?6,
        ?7, 0, NULL,
        NULL, ?8, ?9, ?9
      )
    `,
    args: [
      input.listingId,
      input.communityId,
      input.assetId,
      input.liveRoomId,
      input.status,
      input.priceUsd,
      regionalPricingPolicyJson,
      input.createdByUserId,
      input.now,
    ],
  })

  return await getCommunityListingById({
    client: input.client as Client,
    communityId: input.communityId,
    listingId: input.listingId,
  })
}

export async function updateCommunityListing(input: {
  client: Client
  communityId: string
  listingId: string
  priceUsd?: number
  status?: CommunityListing["status"]
  regionalPricingEnabled?: boolean
  now: string
}): Promise<CommunityListing> {
  const existing = await getCommunityListingById({
    client: input.client,
    communityId: input.communityId,
    listingId: input.listingId,
  })

  const nextRegionalPricingPolicyJson =
    input.regionalPricingEnabled === undefined
      ? (existing.regional_pricing_policy == null ? null : JSON.stringify(existing.regional_pricing_policy))
      : (input.regionalPricingEnabled ? JSON.stringify({ enabled: true, policy_scope: "community_active" }) : null)

  await input.client.execute({
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
      input.status ?? existing.status,
      input.priceUsd ?? existing.price_usd,
      nextRegionalPricingPolicyJson,
      input.now,
    ],
  })

  return await getCommunityListingById({
    client: input.client,
    communityId: input.communityId,
    listingId: input.listingId,
  })
}
