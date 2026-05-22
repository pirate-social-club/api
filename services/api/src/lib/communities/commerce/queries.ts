import type { Client } from "../../sql-client"
import { executeFirst } from "../../db-helpers"
import type {
  Asset,
  CommunityListing,
  CommunityMoneyPolicy,
  CommunityPurchase,
  DerivativeSourceKind,
} from "../../../types"
import type {
  AssetRow,
  ListingRow,
  PurchaseEntitlementRow,
  PurchaseAllocationLegRow,
  PurchaseQuoteRow,
  PurchaseRow,
} from "./row-types"
import type { BuyerIdentity } from "./buyer-identity"
import {
  numberOrNull,
  requiredString,
  sqliteToBool,
  stringOrNull,
} from "./row-types"

type CommerceExecutor = Pick<Client, "execute">

export type DerivativeSourceRow = Pick<
  AssetRow,
  | "asset_id"
  | "community_id"
  | "display_title"
  | "creator_user_id"
  | "asset_kind"
  | "license_preset"
  | "commercial_rev_share_pct"
  | "story_ip_id"
  | "story_license_terms_id"
  | "updated_at"
>

function buildInClause(values: string[], startIndex = 1): { placeholders: string; args: string[] } | null {
  const uniqueValues = Array.from(new Set(values.filter((value) => value.trim())))
  if (uniqueValues.length === 0) {
    return null
  }
  return {
    placeholders: uniqueValues.map((_, index) => `?${startIndex + index}`).join(", "),
    args: uniqueValues,
  }
}

export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

function toPurchaseAllocationLegRow(row: unknown): PurchaseAllocationLegRow {
  return {
    purchase_allocation_leg_id: requiredString(row, "purchase_allocation_leg_id"),
    purchase_id: requiredString(row, "purchase_id"),
    quote_id: requiredString(row, "quote_id"),
    community_id: requiredString(row, "community_id"),
    recipient_type: requiredString(row, "recipient_type") as PurchaseAllocationLegRow["recipient_type"],
    recipient_ref: stringOrNull(row, "recipient_ref"),
    waterfall_position: Number(numberOrNull(row, "waterfall_position") ?? 0),
    share_bps: Number(numberOrNull(row, "share_bps") ?? 0),
    amount_usd: Number(numberOrNull(row, "amount_usd") ?? 0),
    settlement_strategy: requiredString(row, "settlement_strategy") as PurchaseAllocationLegRow["settlement_strategy"],
    status: requiredString(row, "status") as PurchaseAllocationLegRow["status"],
    settlement_ref: stringOrNull(row, "settlement_ref"),
    provider_receipt_ref: stringOrNull(row, "provider_receipt_ref"),
    tax_receipt_ref: stringOrNull(row, "tax_receipt_ref"),
    submitted_at: stringOrNull(row, "submitted_at"),
    confirmed_at: stringOrNull(row, "confirmed_at"),
    failed_at: stringOrNull(row, "failed_at"),
    attempt_count: Number(numberOrNull(row, "attempt_count") ?? 0),
    failure_reason: stringOrNull(row, "failure_reason"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

function toPurchaseEntitlementRow(row: unknown): PurchaseEntitlementRow {
  return {
    purchase_entitlement_id: requiredString(row, "purchase_entitlement_id"),
    purchase_id: requiredString(row, "purchase_id"),
    community_id: requiredString(row, "community_id"),
    buyer_kind: (stringOrNull(row, "buyer_kind") ?? "user") as PurchaseEntitlementRow["buyer_kind"],
    buyer_user_id: stringOrNull(row, "buyer_user_id"),
    buyer_wallet_address: stringOrNull(row, "buyer_wallet_address"),
    buyer_wallet_address_normalized: stringOrNull(row, "buyer_wallet_address_normalized"),
    buyer_chain_ref: stringOrNull(row, "buyer_chain_ref"),
    entitlement_kind: requiredString(row, "entitlement_kind") as CommunityPurchase["entitlement_kind"],
    target_ref: requiredString(row, "target_ref"),
    status: requiredString(row, "status") as PurchaseEntitlementRow["status"],
    granted_at: requiredString(row, "granted_at"),
    revoked_at: stringOrNull(row, "revoked_at"),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

function toListingRow(row: unknown): ListingRow {
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

export async function getAssetRow(
  client: CommerceExecutor,
  communityId: string,
  assetId: string,
): Promise<AssetRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT asset_id, community_id, source_post_id, display_title, song_artifact_bundle_id, creator_user_id, asset_kind,
             rights_basis, access_mode, license_preset, commercial_rev_share_pct,
             primary_content_ref, primary_content_hash, publication_status,
             story_status, story_error, story_ip_id, story_ip_nft_contract, story_ip_nft_token_id,
             story_publish_model, story_license_terms_id, story_license_template, story_royalty_policy,
             story_royalty_policy_id, story_derivative_parent_ip_ids_json, story_derivative_registered_at,
             story_revenue_token, story_royalty_registration_status,
             story_publish_tx_ref, story_asset_version_id,
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
    display_title: stringOrNull(row, "display_title"),
    song_artifact_bundle_id: stringOrNull(row, "song_artifact_bundle_id"),
    creator_user_id: requiredString(row, "creator_user_id"),
    asset_kind: requiredString(row, "asset_kind") as Asset["asset_kind"],
    rights_basis: requiredString(row, "rights_basis") as Asset["rights_basis"],
    access_mode: requiredString(row, "access_mode") as Asset["access_mode"],
    license_preset: stringOrNull(row, "license_preset") as Asset["license_preset"] | null,
    commercial_rev_share_pct: numberOrNull(row, "commercial_rev_share_pct"),
    primary_content_ref: requiredString(row, "primary_content_ref"),
    primary_content_hash: stringOrNull(row, "primary_content_hash"),
    publication_status: requiredString(row, "publication_status") as Asset["publication_status"],
    story_status: requiredString(row, "story_status") as Asset["story_status"],
    story_error: stringOrNull(row, "story_error"),
    story_ip_id: stringOrNull(row, "story_ip_id"),
    story_ip_nft_contract: stringOrNull(row, "story_ip_nft_contract"),
    story_ip_nft_token_id: stringOrNull(row, "story_ip_nft_token_id"),
    story_publish_model: requiredString(row, "story_publish_model") as AssetRow["story_publish_model"],
    story_license_terms_id: stringOrNull(row, "story_license_terms_id"),
    story_license_template: stringOrNull(row, "story_license_template"),
    story_royalty_policy: stringOrNull(row, "story_royalty_policy"),
    story_royalty_policy_id: stringOrNull(row, "story_royalty_policy_id"),
    story_derivative_parent_ip_ids_json: stringOrNull(row, "story_derivative_parent_ip_ids_json"),
    story_derivative_registered_at: stringOrNull(row, "story_derivative_registered_at"),
    story_revenue_token: stringOrNull(row, "story_revenue_token"),
    story_royalty_registration_status:
      requiredString(row, "story_royalty_registration_status") as AssetRow["story_royalty_registration_status"],
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

function assetKindForDerivativeSourceKind(kind: DerivativeSourceKind | null | undefined): Asset["asset_kind"] | null {
  if (kind === "song") return "song_audio"
  if (kind === "video") return "video_file"
  return null
}

export async function listDerivativeSourceRows(input: {
  client: Client
  communityId: string
  kind?: DerivativeSourceKind | null
  query?: string | null
  assetIds?: string[] | null
  limit: number
}): Promise<DerivativeSourceRow[]> {
  const assetKind = assetKindForDerivativeSourceKind(input.kind)
  const query = input.query?.trim()
  const hasQuery = Boolean(query)
  const args: Array<string | number> = [input.communityId]
  let nextArg = 2
  const filters = [
    "community_id = ?1",
    "publication_status = 'story_published'",
    "story_status = 'published'",
    "story_royalty_registration_status = 'registered'",
    "story_ip_id IS NOT NULL",
    "story_ip_id != ''",
    "story_license_terms_id IS NOT NULL",
    "story_license_terms_id != ''",
  ]

  if (assetKind) {
    filters.push(`asset_kind = ?${nextArg}`)
    args.push(assetKind)
    nextArg += 1
  }
  if (hasQuery) {
    filters.push(`LOWER(COALESCE(display_title, asset_id)) LIKE ?${nextArg} ESCAPE '\\'`)
    args.push(`%${escapeLikePattern(query!.toLowerCase())}%`)
    nextArg += 1
  }
  if (input.assetIds) {
    const assetIdClause = buildInClause(input.assetIds, nextArg)
    if (!assetIdClause) {
      return []
    }
    filters.push(`asset_id IN (${assetIdClause.placeholders})`)
    args.push(...assetIdClause.args)
    nextArg += assetIdClause.args.length
  }
  args.push(input.limit)

  const rows = await input.client.execute({
    sql: `
      SELECT asset_id, community_id, display_title, creator_user_id, asset_kind,
             license_preset, commercial_rev_share_pct, story_ip_id, story_license_terms_id,
             updated_at
      FROM assets
      WHERE ${filters.join("\n        AND ")}
      ORDER BY updated_at DESC, asset_id DESC
      LIMIT ?${nextArg}
    `,
    args,
  })

  return rows.rows.map((row) => ({
    asset_id: requiredString(row, "asset_id"),
    community_id: requiredString(row, "community_id"),
    display_title: stringOrNull(row, "display_title"),
    creator_user_id: requiredString(row, "creator_user_id"),
    asset_kind: requiredString(row, "asset_kind") as Asset["asset_kind"],
    license_preset: stringOrNull(row, "license_preset") as Asset["license_preset"] | null,
    commercial_rev_share_pct: numberOrNull(row, "commercial_rev_share_pct"),
    story_ip_id: requiredString(row, "story_ip_id"),
    story_license_terms_id: requiredString(row, "story_license_terms_id"),
    updated_at: requiredString(row, "updated_at"),
  }))
}

export async function getListingRowById(
  client: CommerceExecutor,
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
  return toListingRow(row)
}

export async function getListingRowByAssetId(
  client: CommerceExecutor,
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
  return row ? toListingRow(row) : null
}

export async function getListingRowByLiveRoomId(
  client: CommerceExecutor,
  communityId: string,
  liveRoomId: string,
): Promise<ListingRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT listing_id, community_id, asset_id, live_room_id, listing_mode, status, price_usd,
             regional_pricing_policy_json, created_by_user_id, created_at, updated_at
      FROM listings
      WHERE community_id = ?1
        AND live_room_id = ?2
      ORDER BY created_at DESC
      LIMIT 1
    `,
    args: [communityId, liveRoomId],
  })
  return row ? toListingRow(row) : null
}

export async function listListingRows(
  client: Client,
  communityId: string,
  input: {
    after?: { created_at: string; id: string } | null
    limit: number
  },
): Promise<ListingRow[]> {
  const cursorClause = input.after
    ? "AND (created_at < ?2 OR (created_at = ?2 AND listing_id < ?3))"
    : ""
  const limitArgIndex = input.after ? 4 : 2
  const result = await client.execute({
    sql: `
      SELECT listing_id, community_id, asset_id, live_room_id, listing_mode, status, price_usd,
             regional_pricing_policy_json, created_by_user_id, created_at, updated_at
      FROM listings
      WHERE community_id = ?1
        ${cursorClause}
      ORDER BY created_at DESC, listing_id DESC
      LIMIT ?${limitArgIndex}
    `,
    args: input.after
      ? [communityId, input.after.created_at, input.after.id, input.limit]
      : [communityId, input.limit],
  })
  return result.rows.map(toListingRow)
}

export async function getActiveEntitlementForBuyer(
  client: CommerceExecutor,
  communityId: string,
  userId: string,
  targetRef: string,
): Promise<PurchaseEntitlementRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT purchase_entitlement_id, purchase_id, community_id,
             COALESCE(buyer_kind, 'user') AS buyer_kind, buyer_user_id,
             buyer_wallet_address, buyer_wallet_address_normalized, buyer_chain_ref,
             entitlement_kind,
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
  return row ? toPurchaseEntitlementRow(row) : null
}

export async function getActiveEntitlementForBuyerIdentity(
  client: Client,
  communityId: string,
  buyer: BuyerIdentity,
  targetRef: string,
): Promise<PurchaseEntitlementRow | null> {
  if (buyer.kind === "user") {
    return getActiveEntitlementForBuyer(client, communityId, buyer.userId, targetRef)
  }
  const row = await executeFirst(client, {
    sql: `
      SELECT purchase_entitlement_id, purchase_id, community_id,
             COALESCE(buyer_kind, 'user') AS buyer_kind, buyer_user_id,
             buyer_wallet_address, buyer_wallet_address_normalized, buyer_chain_ref,
             entitlement_kind,
             target_ref, status, granted_at, revoked_at, created_at, updated_at
      FROM purchase_entitlements
      WHERE community_id = ?1
        AND buyer_kind = 'wallet'
        AND buyer_chain_ref = ?2
        AND buyer_wallet_address_normalized = ?3
        AND target_ref = ?4
        AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `,
    args: [communityId, buyer.chainRef, buyer.walletAddressNormalized, targetRef],
  })
  return row ? toPurchaseEntitlementRow(row) : null
}

export async function getPurchaseQuoteRow(
  client: Client,
  communityId: string,
  quoteId: string,
): Promise<PurchaseQuoteRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT quote_id, community_id, listing_id,
             COALESCE(buyer_kind, 'user') AS buyer_kind, buyer_user_id,
             buyer_wallet_address, buyer_wallet_address_normalized, buyer_chain_ref,
             asset_id, live_room_id, base_price_usd,
             pricing_tier, final_price_usd, allocation_snapshot_json, funding_mode, funding_asset_json, source_chain_json,
             route_provider, funding_destination_address, route_policy_compliant, route_live_available, policy_origin,
             destination_settlement_chain_json, destination_settlement_token, destination_settlement_amount_atomic,
             destination_settlement_decimals, treasury_denomination,
             quote_ttl_seconds, route_required, route_status_policy, route_hop_tolerance,
             settlement_mode, verification_snapshot_ref, pricing_policy_version, status, quoted_at, expires_at,
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
    buyer_kind: (stringOrNull(row, "buyer_kind") ?? "user") as PurchaseQuoteRow["buyer_kind"],
    buyer_user_id: stringOrNull(row, "buyer_user_id"),
    buyer_wallet_address: stringOrNull(row, "buyer_wallet_address"),
    buyer_wallet_address_normalized: stringOrNull(row, "buyer_wallet_address_normalized"),
    buyer_chain_ref: stringOrNull(row, "buyer_chain_ref"),
    asset_id: stringOrNull(row, "asset_id"),
    live_room_id: stringOrNull(row, "live_room_id"),
    base_price_usd: Number(numberOrNull(row, "base_price_usd") ?? 0),
    pricing_tier: stringOrNull(row, "pricing_tier"),
    final_price_usd: Number(numberOrNull(row, "final_price_usd") ?? 0),
    allocation_snapshot_json: stringOrNull(row, "allocation_snapshot_json"),
    funding_mode: requiredString(row, "funding_mode") as PurchaseQuoteRow["funding_mode"],
    funding_asset_json: stringOrNull(row, "funding_asset_json"),
    source_chain_json: stringOrNull(row, "source_chain_json"),
    route_provider: stringOrNull(row, "route_provider"),
    funding_destination_address: stringOrNull(row, "funding_destination_address"),
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
    settlement_mode: requiredString(row, "settlement_mode") as PurchaseQuoteRow["settlement_mode"],
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

export async function listPurchaseAllocationLegRows(
  client: Client,
  purchaseId: string,
): Promise<PurchaseAllocationLegRow[]> {
  const result = await client.execute({
    sql: `
      SELECT purchase_allocation_leg_id, purchase_id, quote_id, community_id, recipient_type, recipient_ref,
             waterfall_position, share_bps, amount_usd, settlement_strategy, status, settlement_ref,
             provider_receipt_ref, tax_receipt_ref, submitted_at, confirmed_at, failed_at, attempt_count,
             failure_reason, created_at, updated_at
      FROM purchase_allocation_legs
      WHERE purchase_id = ?1
      ORDER BY waterfall_position ASC, created_at ASC
    `,
    args: [purchaseId],
  })
  return result.rows.map((row) => toPurchaseAllocationLegRow(row))
}

export async function listPurchaseAllocationLegRowsByPurchaseIds(
  client: Client,
  purchaseIds: string[],
): Promise<Map<string, PurchaseAllocationLegRow[]>> {
  const inClause = buildInClause(purchaseIds)
  const rowsByPurchaseId = new Map<string, PurchaseAllocationLegRow[]>()
  if (!inClause) {
    return rowsByPurchaseId
  }

  const result = await client.execute({
    sql: `
      SELECT purchase_allocation_leg_id, purchase_id, quote_id, community_id, recipient_type, recipient_ref,
             waterfall_position, share_bps, amount_usd, settlement_strategy, status, settlement_ref,
             provider_receipt_ref, tax_receipt_ref, submitted_at, confirmed_at, failed_at, attempt_count,
             failure_reason, created_at, updated_at
      FROM purchase_allocation_legs
      WHERE purchase_id IN (${inClause.placeholders})
      ORDER BY purchase_id ASC, waterfall_position ASC, created_at ASC
    `,
    args: inClause.args,
  })

  for (const row of result.rows) {
    const allocation = toPurchaseAllocationLegRow(row)
    const rows = rowsByPurchaseId.get(allocation.purchase_id) ?? []
    rows.push(allocation)
    rowsByPurchaseId.set(allocation.purchase_id, rows)
  }
  return rowsByPurchaseId
}

export async function listPurchaseRows(
  client: Client,
  communityId: string,
  userId: string,
  input: {
    after?: { created_at: string; id: string } | null
    limit: number
  },
): Promise<PurchaseRow[]> {
  const cursorClause = input.after
    ? "AND (p.created_at < ?3 OR (p.created_at = ?3 AND p.purchase_id < ?4))"
    : ""
  const limitArgIndex = input.after ? 5 : 3
  const result = await client.execute({
    sql: `
      SELECT p.purchase_id, p.community_id, p.listing_id, p.asset_id, p.live_room_id,
             COALESCE(p.buyer_kind, 'user') AS buyer_kind, p.buyer_user_id,
             p.buyer_wallet_address, p.buyer_wallet_address_normalized, p.buyer_chain_ref,
             p.settlement_wallet_attachment_id, p.purchase_price_usd, p.pricing_tier, p.settlement_mode, p.settlement_chain,
             p.settlement_token, p.settlement_tx_ref, p.donation_partner_id, p.donation_share_pct,
             p.donation_amount_usd, l.regional_pricing_policy_json AS listing_policy_json, p.created_at
      FROM purchases p
      LEFT JOIN listings l
        ON l.community_id = p.community_id
       AND l.listing_id = p.listing_id
      WHERE p.community_id = ?1
        AND p.buyer_user_id = ?2
        ${cursorClause}
      ORDER BY p.created_at DESC, p.purchase_id DESC
      LIMIT ?${limitArgIndex}
    `,
    args: input.after
      ? [communityId, userId, input.after.created_at, input.after.id, input.limit]
      : [communityId, userId, input.limit],
  })
  return result.rows.map((row) => ({
    purchase_id: requiredString(row, "purchase_id"),
    community_id: requiredString(row, "community_id"),
    listing_id: requiredString(row, "listing_id"),
    asset_id: stringOrNull(row, "asset_id"),
    live_room_id: stringOrNull(row, "live_room_id"),
    buyer_kind: (stringOrNull(row, "buyer_kind") ?? "user") as PurchaseRow["buyer_kind"],
    buyer_user_id: stringOrNull(row, "buyer_user_id"),
    buyer_wallet_address: stringOrNull(row, "buyer_wallet_address"),
    buyer_wallet_address_normalized: stringOrNull(row, "buyer_wallet_address_normalized"),
    buyer_chain_ref: stringOrNull(row, "buyer_chain_ref"),
    settlement_wallet_attachment_id: requiredString(row, "settlement_wallet_attachment_id"),
    purchase_price_usd: Number(numberOrNull(row, "purchase_price_usd") ?? 0),
    pricing_tier: stringOrNull(row, "pricing_tier"),
    settlement_mode: requiredString(row, "settlement_mode") as PurchaseRow["settlement_mode"],
    settlement_chain: requiredString(row, "settlement_chain"),
    settlement_token: requiredString(row, "settlement_token"),
    settlement_tx_ref: requiredString(row, "settlement_tx_ref"),
    donation_partner_id: stringOrNull(row, "donation_partner_id"),
    donation_share_pct: numberOrNull(row, "donation_share_pct"),
    donation_amount_usd: numberOrNull(row, "donation_amount_usd"),
    listing_policy_json: stringOrNull(row, "listing_policy_json"),
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
      SELECT p.purchase_id, p.community_id, p.listing_id, p.asset_id, p.live_room_id,
             COALESCE(p.buyer_kind, 'user') AS buyer_kind, p.buyer_user_id,
             p.buyer_wallet_address, p.buyer_wallet_address_normalized, p.buyer_chain_ref,
             p.settlement_wallet_attachment_id, p.purchase_price_usd, p.pricing_tier, p.settlement_mode, p.settlement_chain,
             p.settlement_token, p.settlement_tx_ref, p.donation_partner_id, p.donation_share_pct,
             p.donation_amount_usd, l.regional_pricing_policy_json AS listing_policy_json, p.created_at
      FROM purchases p
      LEFT JOIN listings l
        ON l.community_id = p.community_id
       AND l.listing_id = p.listing_id
      WHERE p.community_id = ?1
        AND p.purchase_id = ?2
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
    buyer_kind: (stringOrNull(row, "buyer_kind") ?? "user") as PurchaseRow["buyer_kind"],
    buyer_user_id: stringOrNull(row, "buyer_user_id"),
    buyer_wallet_address: stringOrNull(row, "buyer_wallet_address"),
    buyer_wallet_address_normalized: stringOrNull(row, "buyer_wallet_address_normalized"),
    buyer_chain_ref: stringOrNull(row, "buyer_chain_ref"),
    settlement_wallet_attachment_id: requiredString(row, "settlement_wallet_attachment_id"),
    purchase_price_usd: Number(numberOrNull(row, "purchase_price_usd") ?? 0),
    pricing_tier: stringOrNull(row, "pricing_tier"),
    settlement_mode: requiredString(row, "settlement_mode") as PurchaseRow["settlement_mode"],
    settlement_chain: requiredString(row, "settlement_chain"),
    settlement_token: requiredString(row, "settlement_token"),
    settlement_tx_ref: requiredString(row, "settlement_tx_ref"),
    donation_partner_id: stringOrNull(row, "donation_partner_id"),
    donation_share_pct: numberOrNull(row, "donation_share_pct"),
    donation_amount_usd: numberOrNull(row, "donation_amount_usd"),
    listing_policy_json: stringOrNull(row, "listing_policy_json"),
    created_at: requiredString(row, "created_at"),
  } : null
}

export async function getEntitlementRowByPurchase(
  client: Client,
  purchaseId: string,
): Promise<PurchaseEntitlementRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT purchase_entitlement_id, purchase_id, community_id,
             COALESCE(buyer_kind, 'user') AS buyer_kind, buyer_user_id,
             buyer_wallet_address, buyer_wallet_address_normalized, buyer_chain_ref,
             entitlement_kind,
             target_ref, status, granted_at, revoked_at, created_at, updated_at
      FROM purchase_entitlements
      WHERE purchase_id = ?1
      ORDER BY created_at DESC
      LIMIT 1
    `,
    args: [purchaseId],
  })
  return row ? toPurchaseEntitlementRow(row) : null
}

export async function listLatestEntitlementRowsByPurchaseIds(
  client: Client,
  purchaseIds: string[],
): Promise<Map<string, PurchaseEntitlementRow>> {
  const inClause = buildInClause(purchaseIds)
  const rowsByPurchaseId = new Map<string, PurchaseEntitlementRow>()
  if (!inClause) {
    return rowsByPurchaseId
  }

  const result = await client.execute({
    sql: `
      SELECT purchase_entitlement_id, purchase_id, community_id,
             COALESCE(buyer_kind, 'user') AS buyer_kind, buyer_user_id,
             buyer_wallet_address, buyer_wallet_address_normalized, buyer_chain_ref,
             entitlement_kind,
             target_ref, status, granted_at, revoked_at, created_at, updated_at
      FROM purchase_entitlements
      WHERE purchase_id IN (${inClause.placeholders})
      ORDER BY purchase_id ASC, created_at DESC
    `,
    args: inClause.args,
  })

  for (const row of result.rows) {
    const entitlement = toPurchaseEntitlementRow(row)
    if (!rowsByPurchaseId.has(entitlement.purchase_id)) {
      rowsByPurchaseId.set(entitlement.purchase_id, entitlement)
    }
  }
  return rowsByPurchaseId
}
