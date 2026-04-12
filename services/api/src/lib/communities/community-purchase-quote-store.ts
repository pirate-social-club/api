import type { Client, InValue, Transaction } from "@libsql/client"
import { badRequestError } from "../errors"
import { makeId } from "../helpers"
import { numberOrNull, requiredString, rowValue, stringOrNull } from "../sql-row"
import type { CommunityPurchaseQuote } from "../../types"

type PurchaseQuoteRow = {
  quote_id: string
  community_id: string
  listing_id: string
  buyer_user_id: string
  asset_id: string | null
  live_room_id: string | null
  base_price_usd: number
  pricing_tier: string | null
  final_price_usd: number
  funding_mode: CommunityPurchaseQuote["funding_mode"]
  funding_asset_json: string | null
  source_chain_json: string | null
  route_provider: string | null
  route_policy_compliant: boolean
  route_live_available: boolean | null
  policy_origin: CommunityPurchaseQuote["policy_origin"]
  destination_settlement_chain_json: string
  destination_settlement_token: string
  destination_settlement_amount_atomic: string | null
  destination_settlement_decimals: number | null
  treasury_denomination: string | null
  quote_ttl_seconds: number
  route_required: boolean
  route_status_policy: CommunityPurchaseQuote["route_status_policy"]
  route_hop_tolerance: number
  verification_snapshot_ref: string | null
  pricing_policy_version: string | null
  status: "active" | "expired" | "consumed" | "failed"
  quoted_at: string
  expires_at: string
}

type PurchaseExecutor = Pick<Client, "execute"> | Pick<Transaction, "execute">

export type StoredCommunityPurchaseQuote = CommunityPurchaseQuote & {
  status: PurchaseQuoteRow["status"]
}

function parseJsonObject<T>(value: string | null, fieldName: string): T | null {
  if (value == null) {
    return null
  }
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error()
    }
    return parsed as T
  } catch {
    throw badRequestError(`${fieldName} stored value is invalid`)
  }
}

function toPurchaseQuoteRow(row: unknown): PurchaseQuoteRow {
  const basePriceUsd = numberOrNull(rowValue(row, "base_price_usd"))
  const finalPriceUsd = numberOrNull(rowValue(row, "final_price_usd"))
  const quoteTtlSeconds = numberOrNull(rowValue(row, "quote_ttl_seconds"))
  const routeHopTolerance = numberOrNull(rowValue(row, "route_hop_tolerance"))
  const destinationSettlementDecimals = numberOrNull(rowValue(row, "destination_settlement_decimals"))
  if (basePriceUsd == null || basePriceUsd < 0 || finalPriceUsd == null || finalPriceUsd < 0) {
    throw badRequestError("Stored purchase quote price is invalid")
  }
  if (quoteTtlSeconds == null || quoteTtlSeconds < 1 || routeHopTolerance == null || routeHopTolerance < 0) {
    throw badRequestError("Stored purchase quote policy fields are invalid")
  }

  return {
    quote_id: requiredString(row, "quote_id"),
    community_id: requiredString(row, "community_id"),
    listing_id: requiredString(row, "listing_id"),
    buyer_user_id: requiredString(row, "buyer_user_id"),
    asset_id: stringOrNull(rowValue(row, "asset_id")),
    live_room_id: stringOrNull(rowValue(row, "live_room_id")),
    base_price_usd: basePriceUsd,
    pricing_tier: stringOrNull(rowValue(row, "pricing_tier")),
    final_price_usd: finalPriceUsd,
    funding_mode: requiredString(row, "funding_mode") as PurchaseQuoteRow["funding_mode"],
    funding_asset_json: stringOrNull(rowValue(row, "funding_asset_json")),
    source_chain_json: stringOrNull(rowValue(row, "source_chain_json")),
    route_provider: stringOrNull(rowValue(row, "route_provider")),
    route_policy_compliant: Number(rowValue(row, "route_policy_compliant")) === 1,
    route_live_available: rowValue(row, "route_live_available") == null
      ? null
      : Number(rowValue(row, "route_live_available")) === 1,
    policy_origin: requiredString(row, "policy_origin") as PurchaseQuoteRow["policy_origin"],
    destination_settlement_chain_json: requiredString(row, "destination_settlement_chain_json"),
    destination_settlement_token: requiredString(row, "destination_settlement_token"),
    destination_settlement_amount_atomic: stringOrNull(rowValue(row, "destination_settlement_amount_atomic")),
    destination_settlement_decimals: destinationSettlementDecimals,
    treasury_denomination: stringOrNull(rowValue(row, "treasury_denomination")),
    quote_ttl_seconds: quoteTtlSeconds,
    route_required: Number(rowValue(row, "route_required")) === 1,
    route_status_policy: requiredString(row, "route_status_policy") as PurchaseQuoteRow["route_status_policy"],
    route_hop_tolerance: routeHopTolerance,
    verification_snapshot_ref: stringOrNull(rowValue(row, "verification_snapshot_ref")),
    pricing_policy_version: stringOrNull(rowValue(row, "pricing_policy_version")),
    status: requiredString(row, "status") as PurchaseQuoteRow["status"],
    quoted_at: requiredString(row, "quoted_at"),
    expires_at: requiredString(row, "expires_at"),
  }
}

export async function insertCommunityPurchaseQuote(input: {
  client: Client
  quote: CommunityPurchaseQuote
}): Promise<void> {
  const createdAt = input.quote.quoted_at
  const updatedAt = input.quote.quoted_at
  const args: InValue[] = [
    input.quote.quote_id,
    input.quote.community_id,
    input.quote.listing_id,
    input.quote.buyer_user_id,
    input.quote.asset_id ?? null,
    input.quote.live_room_id ?? null,
    input.quote.base_price_usd,
    input.quote.pricing_tier ?? null,
    input.quote.final_price_usd,
    input.quote.funding_mode,
    input.quote.funding_asset == null ? null : JSON.stringify(input.quote.funding_asset),
    input.quote.source_chain == null ? null : JSON.stringify(input.quote.source_chain),
    input.quote.route_provider ?? null,
    input.quote.route_policy_compliant ? 1 : 0,
    input.quote.route_live_available == null ? null : (input.quote.route_live_available ? 1 : 0),
    input.quote.policy_origin,
    JSON.stringify(input.quote.destination_settlement_chain),
    input.quote.destination_settlement_token,
    input.quote.destination_settlement_amount_atomic ?? null,
    input.quote.destination_settlement_decimals ?? null,
    input.quote.treasury_denomination ?? null,
    input.quote.quote_ttl_seconds,
    input.quote.route_required ? 1 : 0,
    input.quote.route_status_policy,
    input.quote.route_hop_tolerance,
    input.quote.verification_snapshot_ref ?? null,
    input.quote.pricing_policy_version ?? null,
    "active",
    input.quote.quoted_at,
    input.quote.expires_at,
    createdAt,
    updatedAt,
  ]

  await input.client.execute({
    sql: `
      INSERT INTO purchase_quotes (
        quote_id, community_id, listing_id, buyer_user_id, asset_id, live_room_id,
        base_price_usd, pricing_tier, final_price_usd, funding_mode, funding_asset_json,
        source_chain_json, route_provider, route_policy_compliant, route_live_available, policy_origin,
        destination_settlement_chain_json, destination_settlement_token,
        destination_settlement_amount_atomic, destination_settlement_decimals, treasury_denomination,
        quote_ttl_seconds, route_required, route_status_policy, route_hop_tolerance,
        verification_snapshot_ref, pricing_policy_version, status, quoted_at, expires_at,
        consumed_at, failed_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6,
        ?7, ?8, ?9, ?10, ?11,
        ?12, ?13, ?14, ?15, ?16,
        ?17, ?18, ?19, ?20,
        ?21, ?22, ?23, ?24,
        ?25, ?26, ?27, ?28, ?29,
        ?30, NULL, NULL, ?31, ?32
      )
    `,
    args,
  })
}

export async function getCommunityPurchaseQuoteById(input: {
  client: Client
  communityId: string
  quoteId: string
}): Promise<StoredCommunityPurchaseQuote | null> {
  const result = await input.client.execute({
    sql: `
      SELECT quote_id, community_id, listing_id, buyer_user_id, asset_id, live_room_id,
             base_price_usd, pricing_tier, final_price_usd, funding_mode, funding_asset_json,
             source_chain_json, route_provider, route_policy_compliant, route_live_available, policy_origin,
             destination_settlement_chain_json, destination_settlement_token,
             destination_settlement_amount_atomic, destination_settlement_decimals, treasury_denomination,
             quote_ttl_seconds, route_required, route_status_policy, route_hop_tolerance,
             verification_snapshot_ref, pricing_policy_version, status, quoted_at, expires_at
      FROM purchase_quotes
      WHERE community_id = ?1
        AND quote_id = ?2
      LIMIT 1
    `,
    args: [input.communityId, input.quoteId],
  })

  const row = result.rows[0]
  if (!row) {
    return null
  }

  const parsed = toPurchaseQuoteRow(row)
  return {
    quote_id: parsed.quote_id,
    community_id: parsed.community_id,
    listing_id: parsed.listing_id,
    buyer_user_id: parsed.buyer_user_id,
    asset_id: parsed.asset_id,
    live_room_id: parsed.live_room_id,
    base_price_usd: parsed.base_price_usd,
    pricing_tier: parsed.pricing_tier,
    final_price_usd: parsed.final_price_usd,
    funding_mode: parsed.funding_mode,
    funding_asset: parseJsonObject<CommunityPurchaseQuote["funding_asset"]>(parsed.funding_asset_json, "funding_asset"),
    source_chain: parseJsonObject<CommunityPurchaseQuote["source_chain"]>(parsed.source_chain_json, "source_chain"),
    route_provider: parsed.route_provider,
    route_policy_compliant: parsed.route_policy_compliant,
    route_live_available: parsed.route_live_available,
    policy_origin: parsed.policy_origin,
    destination_settlement_chain: parseJsonObject<CommunityPurchaseQuote["destination_settlement_chain"]>(
      parsed.destination_settlement_chain_json,
      "destination_settlement_chain",
    )!,
    destination_settlement_token: parsed.destination_settlement_token,
    destination_settlement_amount_atomic: parsed.destination_settlement_amount_atomic,
    destination_settlement_decimals: parsed.destination_settlement_decimals,
    treasury_denomination: parsed.treasury_denomination,
    quote_ttl_seconds: parsed.quote_ttl_seconds,
    route_required: parsed.route_required,
    route_status_policy: parsed.route_status_policy,
    route_hop_tolerance: parsed.route_hop_tolerance,
    verification_snapshot_ref: parsed.verification_snapshot_ref,
    pricing_policy_version: parsed.pricing_policy_version,
    status: parsed.status,
    quoted_at: parsed.quoted_at,
    expires_at: parsed.expires_at,
  }
}

export async function markCommunityPurchaseQuoteExpired(input: {
  client: PurchaseExecutor
  communityId: string
  quoteId: string
  now: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE purchase_quotes
      SET status = 'expired',
          updated_at = ?3
      WHERE community_id = ?1
        AND quote_id = ?2
        AND status = 'active'
    `,
    args: [input.communityId, input.quoteId, input.now],
  })
}

export async function markCommunityPurchaseQuoteFailed(input: {
  client: PurchaseExecutor
  communityId: string
  quoteId: string
  now: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE purchase_quotes
      SET status = 'failed',
          failed_at = ?3,
          updated_at = ?3
      WHERE community_id = ?1
        AND quote_id = ?2
        AND status = 'active'
    `,
    args: [input.communityId, input.quoteId, input.now],
  })
}

export async function insertCommunityPurchaseAndConsumeQuote(input: {
  client: Transaction
  quote: StoredCommunityPurchaseQuote
  settlementWalletAttachmentId: string
  settlementTxRef: string
  now: string
}): Promise<{
  purchase_id: string
  purchase_entitlement_id: string
  entitlement_kind: "asset_access" | "live_room_access"
  entitlement_target_ref: string
}> {
  const purchaseId = makeId("pur")
  const purchaseEntitlementId = makeId("pent")
  const entitlementKind = input.quote.asset_id == null ? "live_room_access" : "asset_access"
  const entitlementTargetRef = input.quote.asset_id ?? input.quote.live_room_id!

  await input.client.execute({
    sql: `
      INSERT INTO purchases (
        purchase_id, community_id, listing_id, asset_id, live_room_id, buyer_user_id,
        settlement_wallet_attachment_id, purchase_price_usd, pricing_tier, settlement_chain,
        settlement_token, settlement_tx_ref, donation_partner_id, donation_share_pct,
        donation_amount_usd, donation_settlement_ref, created_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6,
        ?7, ?8, ?9, ?10,
        ?11, ?12, NULL, NULL,
        NULL, NULL, ?13
      )
    `,
    args: [
      purchaseId,
      input.quote.community_id,
      input.quote.listing_id,
      input.quote.asset_id ?? null,
      input.quote.live_room_id ?? null,
      input.quote.buyer_user_id,
      input.settlementWalletAttachmentId,
      input.quote.final_price_usd,
      input.quote.pricing_tier ?? null,
      JSON.stringify(input.quote.destination_settlement_chain),
      input.quote.destination_settlement_token,
      input.settlementTxRef,
      input.now,
    ],
  })

  await input.client.execute({
    sql: `
      INSERT INTO purchase_entitlements (
        purchase_entitlement_id, purchase_id, community_id, buyer_user_id, entitlement_kind,
        target_ref, status, granted_at, revoked_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5,
        ?6, 'active', ?7, NULL, ?7, ?7
      )
    `,
    args: [
      purchaseEntitlementId,
      purchaseId,
      input.quote.community_id,
      input.quote.buyer_user_id,
      entitlementKind,
      entitlementTargetRef,
      input.now,
    ],
  })

  await input.client.execute({
    sql: `
      UPDATE purchase_quotes
      SET status = 'consumed',
          consumed_at = ?3,
          updated_at = ?3
      WHERE community_id = ?1
        AND quote_id = ?2
        AND status = 'active'
    `,
    args: [input.quote.community_id, input.quote.quote_id, input.now],
  })

  return {
    purchase_id: purchaseId,
    purchase_entitlement_id: purchaseEntitlementId,
    entitlement_kind: entitlementKind,
    entitlement_target_ref: entitlementTargetRef,
  }
}
