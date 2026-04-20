import type { Client } from "../sql-client"
import { executeFirst } from "../db-helpers"
import type {
  Asset,
  CommunityListing,
  CommunityMoneyPolicy,
  CommunityPurchase,
} from "../../types"
import type {
  AssetRow,
  ListingRow,
  PurchaseEntitlementRow,
  PurchaseQuoteRow,
  PurchaseRow,
} from "./community-commerce-row-types"
import {
  numberOrNull,
  requiredString,
  sqliteToBool,
  stringOrNull,
} from "./community-commerce-row-types"

export async function getAssetRow(
  client: Client,
  communityId: string,
  assetId: string,
): Promise<AssetRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT asset_id, community_id, source_post_id, song_artifact_bundle_id, creator_user_id, asset_kind,
             rights_basis, access_mode, primary_content_ref, primary_content_hash, publication_status,
             story_status, story_error, story_ip_id, story_publish_tx_ref, story_asset_version_id,
             story_cdr_vault_uuid, story_namespace, story_entitlement_token_id, story_read_condition,
             story_write_condition, locked_delivery_status, locked_delivery_ref, locked_delivery_error,
             locked_delivery_storage_ref, locked_delivery_secret_json, created_at, updated_at
      FROM assets
      WHERE community_id = ?1
        AND asset_id = ?2
      LIMIT 1
    `,
    args: [communityId, assetId],
  })
  if (!row) {
    return null
  }
  return {
    asset_id: requiredString(row, "asset_id"),
    community_id: requiredString(row, "community_id"),
    source_post_id: requiredString(row, "source_post_id"),
    song_artifact_bundle_id: stringOrNull(row, "song_artifact_bundle_id"),
    creator_user_id: requiredString(row, "creator_user_id"),
    asset_kind: requiredString(row, "asset_kind") as Asset["asset_kind"],
    rights_basis: requiredString(row, "rights_basis") as Asset["rights_basis"],
    access_mode: requiredString(row, "access_mode") as Asset["access_mode"],
    primary_content_ref: requiredString(row, "primary_content_ref"),
    primary_content_hash: stringOrNull(row, "primary_content_hash"),
    publication_status: requiredString(row, "publication_status") as Asset["publication_status"],
    story_status: requiredString(row, "story_status") as Asset["story_status"],
    story_error: stringOrNull(row, "story_error"),
    story_ip_id: stringOrNull(row, "story_ip_id"),
    story_publish_tx_ref: stringOrNull(row, "story_publish_tx_ref"),
    story_asset_version_id: stringOrNull(row, "story_asset_version_id"),
    story_cdr_vault_uuid: numberOrNull(row, "story_cdr_vault_uuid"),
    story_namespace: stringOrNull(row, "story_namespace"),
    story_entitlement_token_id: stringOrNull(row, "story_entitlement_token_id"),
    story_read_condition: stringOrNull(row, "story_read_condition"),
    story_write_condition: stringOrNull(row, "story_write_condition"),
    locked_delivery_status: requiredString(row, "locked_delivery_status") as Asset["locked_delivery_status"],
    locked_delivery_ref: stringOrNull(row, "locked_delivery_ref"),
    locked_delivery_error: stringOrNull(row, "locked_delivery_error"),
    locked_delivery_storage_ref: stringOrNull(row, "locked_delivery_storage_ref"),
    locked_delivery_secret_json: stringOrNull(row, "locked_delivery_secret_json"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export async function getListingRowById(
  client: Client,
  communityId: string,
  listingId: string,
): Promise<ListingRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT listing_id, community_id, asset_id, live_room_id, listing_mode, status, price_usd,
             regional_pricing_policy_json, created_by_user_id, created_at, updated_at
      FROM listings
      WHERE community_id = ?1
        AND listing_id = ?2
      LIMIT 1
    `,
    args: [communityId, listingId],
  })
  if (!row) {
    return null
  }
  return {
    listing_id: requiredString(row, "listing_id"),
    community_id: requiredString(row, "community_id"),
    asset_id: stringOrNull(row, "asset_id"),
    live_room_id: stringOrNull(row, "live_room_id"),
    listing_mode: requiredString(row, "listing_mode") as CommunityListing["listing_mode"],
    status: requiredString(row, "status") as CommunityListing["status"],
    price_usd: Number(numberOrNull(row, "price_usd") ?? 0),
    regional_pricing_policy_json: stringOrNull(row, "regional_pricing_policy_json"),
    created_by_user_id: requiredString(row, "created_by_user_id"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export async function getListingRowByAssetId(
  client: Client,
  communityId: string,
  assetId: string,
): Promise<ListingRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT listing_id, community_id, asset_id, live_room_id, listing_mode, status, price_usd,
             regional_pricing_policy_json, created_by_user_id, created_at, updated_at
      FROM listings
      WHERE community_id = ?1
        AND asset_id = ?2
      ORDER BY created_at DESC
      LIMIT 1
    `,
    args: [communityId, assetId],
  })
  return row ? {
    listing_id: requiredString(row, "listing_id"),
    community_id: requiredString(row, "community_id"),
    asset_id: stringOrNull(row, "asset_id"),
    live_room_id: stringOrNull(row, "live_room_id"),
    listing_mode: requiredString(row, "listing_mode") as CommunityListing["listing_mode"],
    status: requiredString(row, "status") as CommunityListing["status"],
    price_usd: Number(numberOrNull(row, "price_usd") ?? 0),
    regional_pricing_policy_json: stringOrNull(row, "regional_pricing_policy_json"),
    created_by_user_id: requiredString(row, "created_by_user_id"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  } : null
}

export async function listListingRows(client: Client, communityId: string): Promise<ListingRow[]> {
  const result = await client.execute({
    sql: `
      SELECT listing_id, community_id, asset_id, live_room_id, listing_mode, status, price_usd,
             regional_pricing_policy_json, created_by_user_id, created_at, updated_at
      FROM listings
      WHERE community_id = ?1
      ORDER BY created_at DESC
    `,
    args: [communityId],
  })
  return result.rows.map((row) => ({
    listing_id: requiredString(row, "listing_id"),
    community_id: requiredString(row, "community_id"),
    asset_id: stringOrNull(row, "asset_id"),
    live_room_id: stringOrNull(row, "live_room_id"),
    listing_mode: requiredString(row, "listing_mode") as CommunityListing["listing_mode"],
    status: requiredString(row, "status") as CommunityListing["status"],
    price_usd: Number(numberOrNull(row, "price_usd") ?? 0),
    regional_pricing_policy_json: stringOrNull(row, "regional_pricing_policy_json"),
    created_by_user_id: requiredString(row, "created_by_user_id"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }))
}

export async function getActiveEntitlementForBuyer(
  client: Client,
  communityId: string,
  userId: string,
  targetRef: string,
): Promise<PurchaseEntitlementRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT purchase_entitlement_id, purchase_id, community_id, buyer_user_id, entitlement_kind,
             target_ref, status, granted_at, revoked_at, created_at, updated_at
      FROM purchase_entitlements
      WHERE community_id = ?1
        AND buyer_user_id = ?2
        AND target_ref = ?3
        AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    args: [communityId, userId, targetRef],
  })
  return row ? {
    purchase_entitlement_id: requiredString(row, "purchase_entitlement_id"),
    purchase_id: requiredString(row, "purchase_id"),
    community_id: requiredString(row, "community_id"),
    buyer_user_id: requiredString(row, "buyer_user_id"),
    entitlement_kind: requiredString(row, "entitlement_kind") as CommunityPurchase["entitlement_kind"],
    target_ref: requiredString(row, "target_ref"),
    status: requiredString(row, "status") as PurchaseEntitlementRow["status"],
    granted_at: requiredString(row, "granted_at"),
    revoked_at: stringOrNull(row, "revoked_at"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  } : null
}

export async function getPurchaseQuoteRow(
  client: Client,
  communityId: string,
  quoteId: string,
): Promise<PurchaseQuoteRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT quote_id, community_id, listing_id, buyer_user_id, asset_id, live_room_id, base_price_usd,
             pricing_tier, final_price_usd, funding_mode, funding_asset_json, source_chain_json,
             route_provider, route_policy_compliant, route_live_available, policy_origin,
             destination_settlement_chain_json, destination_settlement_token, destination_settlement_amount_atomic,
             destination_settlement_decimals, treasury_denomination,
             quote_ttl_seconds, route_required, route_status_policy, route_hop_tolerance,
             verification_snapshot_ref, pricing_policy_version, status, quoted_at, expires_at,
             consumed_at, failed_at, created_at, updated_at
      FROM purchase_quotes
      WHERE community_id = ?1
        AND quote_id = ?2
      LIMIT 1
    `,
    args: [communityId, quoteId],
  })
  return row ? {
    quote_id: requiredString(row, "quote_id"),
    community_id: requiredString(row, "community_id"),
    listing_id: requiredString(row, "listing_id"),
    buyer_user_id: requiredString(row, "buyer_user_id"),
    asset_id: stringOrNull(row, "asset_id"),
    live_room_id: stringOrNull(row, "live_room_id"),
    base_price_usd: Number(numberOrNull(row, "base_price_usd") ?? 0),
    pricing_tier: stringOrNull(row, "pricing_tier"),
    final_price_usd: Number(numberOrNull(row, "final_price_usd") ?? 0),
    funding_mode: requiredString(row, "funding_mode") as PurchaseQuoteRow["funding_mode"],
    funding_asset_json: stringOrNull(row, "funding_asset_json"),
    source_chain_json: stringOrNull(row, "source_chain_json"),
    route_provider: stringOrNull(row, "route_provider"),
    route_policy_compliant: sqliteToBool((row as Record<string, unknown>).route_policy_compliant),
    route_live_available: (row as Record<string, unknown>).route_live_available == null
      ? null
      : sqliteToBool((row as Record<string, unknown>).route_live_available),
    policy_origin: requiredString(row, "policy_origin") as CommunityMoneyPolicy["policy_origin"],
    destination_settlement_chain_json: requiredString(row, "destination_settlement_chain_json"),
    destination_settlement_token: requiredString(row, "destination_settlement_token"),
    destination_settlement_amount_atomic: stringOrNull(row, "destination_settlement_amount_atomic"),
    destination_settlement_decimals: numberOrNull(row, "destination_settlement_decimals"),
    treasury_denomination: stringOrNull(row, "treasury_denomination"),
    quote_ttl_seconds: Number(numberOrNull(row, "quote_ttl_seconds") ?? 0),
    route_required: sqliteToBool((row as Record<string, unknown>).route_required),
    route_status_policy: requiredString(row, "route_status_policy") as CommunityMoneyPolicy["route_status_policy"],
    route_hop_tolerance: Number(numberOrNull(row, "route_hop_tolerance") ?? 0),
    verification_snapshot_ref: stringOrNull(row, "verification_snapshot_ref"),
    pricing_policy_version: stringOrNull(row, "pricing_policy_version"),
    status: requiredString(row, "status") as PurchaseQuoteRow["status"],
    quoted_at: requiredString(row, "quoted_at"),
    expires_at: requiredString(row, "expires_at"),
    consumed_at: stringOrNull(row, "consumed_at"),
    failed_at: stringOrNull(row, "failed_at"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  } : null
}

export async function listPurchaseRows(
  client: Client,
  communityId: string,
  userId: string,
): Promise<PurchaseRow[]> {
  const result = await client.execute({
    sql: `
      SELECT purchase_id, community_id, listing_id, asset_id, live_room_id, buyer_user_id,
             settlement_wallet_attachment_id, purchase_price_usd, pricing_tier, settlement_chain,
             settlement_token, settlement_tx_ref, donation_partner_id, donation_share_pct,
             donation_amount_usd, created_at
      FROM purchases
      WHERE community_id = ?1
        AND buyer_user_id = ?2
      ORDER BY created_at DESC
    `,
    args: [communityId, userId],
  })
  return result.rows.map((row) => ({
    purchase_id: requiredString(row, "purchase_id"),
    community_id: requiredString(row, "community_id"),
    listing_id: requiredString(row, "listing_id"),
    asset_id: stringOrNull(row, "asset_id"),
    live_room_id: stringOrNull(row, "live_room_id"),
    buyer_user_id: requiredString(row, "buyer_user_id"),
    settlement_wallet_attachment_id: requiredString(row, "settlement_wallet_attachment_id"),
    purchase_price_usd: Number(numberOrNull(row, "purchase_price_usd") ?? 0),
    pricing_tier: stringOrNull(row, "pricing_tier"),
    settlement_chain: requiredString(row, "settlement_chain"),
    settlement_token: requiredString(row, "settlement_token"),
    settlement_tx_ref: requiredString(row, "settlement_tx_ref"),
    donation_partner_id: stringOrNull(row, "donation_partner_id"),
    donation_share_pct: numberOrNull(row, "donation_share_pct"),
    donation_amount_usd: numberOrNull(row, "donation_amount_usd"),
    created_at: requiredString(row, "created_at"),
  }))
}

export async function getPurchaseRow(
  client: Client,
  communityId: string,
  purchaseId: string,
): Promise<PurchaseRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT purchase_id, community_id, listing_id, asset_id, live_room_id, buyer_user_id,
             settlement_wallet_attachment_id, purchase_price_usd, pricing_tier, settlement_chain,
             settlement_token, settlement_tx_ref, donation_partner_id, donation_share_pct,
             donation_amount_usd, created_at
      FROM purchases
      WHERE community_id = ?1
        AND purchase_id = ?2
      LIMIT 1
    `,
    args: [communityId, purchaseId],
  })
  return row ? {
    purchase_id: requiredString(row, "purchase_id"),
    community_id: requiredString(row, "community_id"),
    listing_id: requiredString(row, "listing_id"),
    asset_id: stringOrNull(row, "asset_id"),
    live_room_id: stringOrNull(row, "live_room_id"),
    buyer_user_id: requiredString(row, "buyer_user_id"),
    settlement_wallet_attachment_id: requiredString(row, "settlement_wallet_attachment_id"),
    purchase_price_usd: Number(numberOrNull(row, "purchase_price_usd") ?? 0),
    pricing_tier: stringOrNull(row, "pricing_tier"),
    settlement_chain: requiredString(row, "settlement_chain"),
    settlement_token: requiredString(row, "settlement_token"),
    settlement_tx_ref: requiredString(row, "settlement_tx_ref"),
    donation_partner_id: stringOrNull(row, "donation_partner_id"),
    donation_share_pct: numberOrNull(row, "donation_share_pct"),
    donation_amount_usd: numberOrNull(row, "donation_amount_usd"),
    created_at: requiredString(row, "created_at"),
  } : null
}

export async function getEntitlementRowByPurchase(
  client: Client,
  purchaseId: string,
): Promise<PurchaseEntitlementRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT purchase_entitlement_id, purchase_id, community_id, buyer_user_id, entitlement_kind,
             target_ref, status, granted_at, revoked_at, created_at, updated_at
      FROM purchase_entitlements
      WHERE purchase_id = ?1
      ORDER BY created_at DESC
      LIMIT 1
    `,
    args: [purchaseId],
  })
  return row ? {
    purchase_entitlement_id: requiredString(row, "purchase_entitlement_id"),
    purchase_id: requiredString(row, "purchase_id"),
    community_id: requiredString(row, "community_id"),
    buyer_user_id: requiredString(row, "buyer_user_id"),
    entitlement_kind: requiredString(row, "entitlement_kind") as CommunityPurchase["entitlement_kind"],
    target_ref: requiredString(row, "target_ref"),
    status: requiredString(row, "status") as PurchaseEntitlementRow["status"],
    granted_at: requiredString(row, "granted_at"),
    revoked_at: stringOrNull(row, "revoked_at"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  } : null
}
