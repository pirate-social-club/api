import type { Client } from "@libsql/client"
import { badRequestError, notFoundError } from "../errors"
import { numberOrNull, requiredString, rowValue, stringOrNull } from "../sql-row"
import type { CommunityPurchase } from "../../types"

type StoredCommunityPurchase = CommunityPurchase

function parseJsonObject<T>(value: unknown, fieldName: string): T {
  const raw = stringOrNull(value)
  if (raw == null) {
    throw badRequestError(`${fieldName} stored value is invalid`)
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error()
    }
    return parsed as T
  } catch {
    throw badRequestError(`${fieldName} stored value is invalid`)
  }
}

function toCommunityPurchase(row: unknown): StoredCommunityPurchase {
  const purchasePriceUsd = numberOrNull(rowValue(row, "purchase_price_usd"))
  if (purchasePriceUsd == null || purchasePriceUsd < 0) {
    throw badRequestError("Stored purchase price is invalid")
  }

  return {
    purchase_id: requiredString(row, "purchase_id"),
    community_id: requiredString(row, "community_id"),
    listing_id: requiredString(row, "listing_id"),
    asset_id: stringOrNull(rowValue(row, "asset_id")),
    live_room_id: stringOrNull(rowValue(row, "live_room_id")),
    buyer_user_id: requiredString(row, "buyer_user_id"),
    settlement_wallet_attachment_id: requiredString(row, "settlement_wallet_attachment_id"),
    purchase_price_usd: purchasePriceUsd,
    pricing_tier: stringOrNull(rowValue(row, "pricing_tier")),
    settlement_chain: parseJsonObject<CommunityPurchase["settlement_chain"]>(rowValue(row, "settlement_chain"), "settlement_chain"),
    settlement_token: requiredString(row, "settlement_token"),
    settlement_tx_ref: requiredString(row, "settlement_tx_ref"),
    purchase_entitlement_id: requiredString(row, "purchase_entitlement_id"),
    entitlement_kind: requiredString(row, "entitlement_kind") as CommunityPurchase["entitlement_kind"],
    entitlement_target_ref: requiredString(row, "entitlement_target_ref"),
    created_at: requiredString(row, "created_at"),
  }
}

export async function listCommunityPurchasesByBuyer(input: {
  client: Client
  communityId: string
  buyerUserId: string
}): Promise<StoredCommunityPurchase[]> {
  const result = await input.client.execute({
    sql: `
      SELECT p.purchase_id, p.community_id, p.listing_id, p.asset_id, p.live_room_id,
             p.buyer_user_id, p.settlement_wallet_attachment_id, p.purchase_price_usd,
             p.pricing_tier, p.settlement_chain, p.settlement_token, p.settlement_tx_ref,
             e.purchase_entitlement_id, e.entitlement_kind, e.target_ref AS entitlement_target_ref,
             p.created_at
      FROM purchases p
      JOIN purchase_entitlements e
        ON e.purchase_id = p.purchase_id
       AND e.community_id = p.community_id
      WHERE p.community_id = ?1
        AND p.buyer_user_id = ?2
      ORDER BY p.created_at DESC, p.purchase_id DESC
    `,
    args: [input.communityId, input.buyerUserId],
  })

  return result.rows.map((row) => toCommunityPurchase(row))
}

export async function getCommunityPurchaseById(input: {
  client: Client
  communityId: string
  purchaseId: string
}): Promise<StoredCommunityPurchase | null> {
  const result = await input.client.execute({
    sql: `
      SELECT p.purchase_id, p.community_id, p.listing_id, p.asset_id, p.live_room_id,
             p.buyer_user_id, p.settlement_wallet_attachment_id, p.purchase_price_usd,
             p.pricing_tier, p.settlement_chain, p.settlement_token, p.settlement_tx_ref,
             e.purchase_entitlement_id, e.entitlement_kind, e.target_ref AS entitlement_target_ref,
             p.created_at
      FROM purchases p
      JOIN purchase_entitlements e
        ON e.purchase_id = p.purchase_id
       AND e.community_id = p.community_id
      WHERE p.community_id = ?1
        AND p.purchase_id = ?2
      LIMIT 1
    `,
    args: [input.communityId, input.purchaseId],
  })

  const row = result.rows[0]
  if (!row) {
    return null
  }
  return toCommunityPurchase(row)
}

export async function hasActiveAssetAccessEntitlement(input: {
  client: Client
  communityId: string
  buyerUserId: string
  assetId: string
}): Promise<boolean> {
  // `purchase_entitlements.target_ref` is canonically the bare `asset_id` for `asset_access`.
  // If settlement ever switches to a URI/ref wrapper, this lookup must be updated in lockstep.
  const result = await input.client.execute({
    sql: `
      SELECT 1
      FROM purchase_entitlements
      WHERE community_id = ?1
        AND buyer_user_id = ?2
        AND entitlement_kind = 'asset_access'
        AND target_ref = ?3
        AND status = 'active'
      LIMIT 1
    `,
    args: [input.communityId, input.buyerUserId, input.assetId],
  })

  return result.rows.length > 0
}
