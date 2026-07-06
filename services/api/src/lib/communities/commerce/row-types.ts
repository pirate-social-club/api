import { notFoundError } from "../../errors"
import type {
  Asset,
  CommunityListing,
  CommunityMoneyPolicy,
  CommunityPurchase,
  CommunityPurchaseQuote,
} from "../../../types"

export type AssetRow = {
  asset_id: string
  community_id: string
  source_post_id: string
  display_title: string | null
  song_artifact_bundle_id: string | null
  creator_user_id: string
  asset_kind: Asset["asset_kind"]
  rights_basis: Asset["rights_basis"]
  access_mode: Asset["access_mode"]
  license_preset: Asset["license_preset"] | null
  commercial_rev_share_pct: number | null
  primary_content_ref: string
  primary_content_hash: string | null
  publication_status: Asset["publication_status"]
  story_status: Asset["story_status"]
  story_error: string | null
  story_ip_id: string | null
  story_ip_nft_contract: string | null
  story_ip_nft_token_id: string | null
  ip_royalty_vault: string | null
  story_publish_model: "pirate_v1" | "story_ip_v1"
  story_license_terms_id: string | null
  story_license_template: string | null
  story_royalty_policy: string | null
  story_royalty_policy_id: string | null
  story_derivative_parent_ip_ids_json: string | null
  story_derivative_registered_at: string | null
  story_revenue_token: string | null
  story_royalty_registration_status: "none" | "pending" | "registered" | "failed"
  story_publish_tx_ref: string | null
  story_asset_version_id: string | null
  story_cdr_vault_uuid: number | null
  story_namespace: string | null
  story_entitlement_token_id: string | null
  story_read_condition: string | null
  story_write_condition: string | null
  locked_delivery_status: Asset["locked_delivery_status"]
  locked_delivery_ref: string | null
  locked_delivery_error: string | null
  locked_delivery_storage_ref: string | null
  locked_delivery_secret_json: string | null
  created_at: string
  updated_at: string
}

export type ListingRow = {
  listing_id: string
  community_id: string
  asset_id: string | null
  live_room_id: string | null
  replay_asset_id: string | null
  listing_mode: CommunityListing["listing_mode"]
  status: CommunityListing["status"]
  price_usd: number
  regional_pricing_policy_json: string | null
  vinyl_release_provider: CommunityListing["vinyl_release_provider"] | null
  vinyl_release_url: string | null
  created_by_user_id: string
  created_at: string
  updated_at: string
}

export type ListingPolicySnapshot = {
  regional_pricing_enabled?: boolean
  donation_partner_id?: string | null
  donation_share_pct?: number | null
}

export type QuoteAllocationSnapshot = Omit<NonNullable<CommunityPurchaseQuote["allocation_snapshot"]>[number], "amount_cents"> & {
  amount_usd: number
}

export type PurchaseAllocationLeg = NonNullable<CommunityPurchase["allocations"]>[number]

export type PurchaseSettlementMode = "delivery_only_story_settlement" | "royalty_native_story_payment"

export type PurchaseQuoteRow = {
  quote_id: string
  community_id: string
  listing_id: string
  buyer_kind: "user" | "wallet"
  buyer_user_id: string | null
  buyer_wallet_address: string | null
  buyer_wallet_address_normalized: string | null
  buyer_chain_ref: string | null
  asset_id: string | null
  live_room_id: string | null
  replay_asset_id: string | null
  base_price_usd: number
  pricing_tier: string | null
  final_price_usd: number
  allocation_snapshot_json: string | null
  funding_mode: "direct" | "routed"
  funding_asset_json: string | null
  source_chain_json: string | null
  route_provider: string | null
  funding_destination_address: string | null
  route_policy_compliant: boolean
  route_live_available: boolean | null
  policy_origin: CommunityMoneyPolicy["policy_origin"]
  destination_settlement_chain_json: string
  destination_settlement_token: string
  destination_settlement_amount_atomic: string | null
  destination_settlement_decimals: number | null
  treasury_denomination: string | null
  quote_ttl_seconds: number
  route_required: boolean
  route_status_policy: CommunityMoneyPolicy["route_status_policy"]
  route_hop_tolerance: number
  settlement_mode: PurchaseSettlementMode
  verification_snapshot_ref: string | null
  pricing_policy_version: string | null
  status: "active" | "expired" | "consumed" | "failed"
  quoted_at: string
  expires_at: string
  consumed_at: string | null
  failed_at: string | null
  created_at: string
  updated_at: string
}

export type PurchaseAllocationLegRow = {
  purchase_allocation_leg_id: string
  purchase_id: string
  quote_id: string
  community_id: string
  recipient_type: PurchaseAllocationLeg["recipient_type"]
  recipient_ref: string | null
  waterfall_position: number
  share_bps: number
  amount_usd: number
  settlement_strategy: PurchaseAllocationLeg["settlement_strategy"]
  status: PurchaseAllocationLeg["status"]
  settlement_ref: string | null
  provider_receipt_ref: string | null
  tax_receipt_ref: string | null
  submitted_at: string | null
  confirmed_at: string | null
  failed_at: string | null
  attempt_count: number
  failure_reason: string | null
  created_at: string
  updated_at: string
}

export type PurchaseRow = {
  purchase_id: string
  community_id: string
  listing_id: string
  asset_id: string | null
  live_room_id: string | null
  replay_asset_id: string | null
  buyer_kind: "user" | "wallet"
  buyer_user_id: string | null
  buyer_wallet_address: string | null
  buyer_wallet_address_normalized: string | null
  buyer_chain_ref: string | null
  settlement_wallet_attachment_id: string
  purchase_price_usd: number
  pricing_tier: string | null
  settlement_mode: PurchaseSettlementMode
  settlement_chain: string
  settlement_token: string
  settlement_tx_ref: string
  donation_partner_id: string | null
  donation_share_pct: number | null
  donation_amount_usd: number | null
  vinyl_release_provider: CommunityPurchase["vinyl_release_provider"] | null
  vinyl_release_url: string | null
  created_at: string
}

export type PurchaseEntitlementRow = {
  purchase_entitlement_id: string
  purchase_id: string
  community_id: string
  buyer_kind: "user" | "wallet"
  buyer_user_id: string | null
  buyer_wallet_address: string | null
  buyer_wallet_address_normalized: string | null
  buyer_chain_ref: string | null
  entitlement_kind: CommunityPurchase["entitlement_kind"]
  target_ref: string
  status: "active" | "revoked" | "expired"
  granted_at: string
  revoked_at: string | null
  created_at: string
  updated_at: string
}

export function parseJsonValue<T>(value: string | null, fallback: T): T {
  if (!value?.trim()) {
    return fallback
  }
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function toChainRefString(chain: CommunityMoneyPolicy["destination_settlement_chain"]): string {
  return chain.chain_id != null ? `${chain.chain_namespace}:${chain.chain_id}` : chain.chain_namespace
}

export function boolToSqlite(value: boolean): 0 | 1 {
  return value ? 1 : 0
}

export function sqliteToBool(value: unknown): boolean {
  return Number(value ?? 0) === 1
}

export function requiredString(row: unknown, key: string): string {
  if (!row || typeof row !== "object" || !(key in row)) {
    throw notFoundError(`Missing ${key}`)
  }
  const value = (row as Record<string, unknown>)[key]
  if (typeof value !== "string") {
    throw notFoundError(`Missing ${key}`)
  }
  return value
}

export function stringOrNull(row: unknown, key: string): string | null {
  if (!row || typeof row !== "object" || !(key in row)) {
    return null
  }
  const value = (row as Record<string, unknown>)[key]
  return typeof value === "string" ? value : null
}

export function numberOrNull(row: unknown, key: string): number | null {
  if (!row || typeof row !== "object" || !(key in row)) {
    return null
  }
  const value = (row as Record<string, unknown>)[key]
  if (typeof value === "number") {
    return value
  }
  if (typeof value === "bigint") {
    return Number(value)
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}
