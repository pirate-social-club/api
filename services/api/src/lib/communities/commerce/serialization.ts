import type {
  Asset,
  CommunityListing,
  CommunityPurchase,
  CommunityPurchaseQuote,
} from "../../../types"
import type {
  AssetRow,
  ListingPolicySnapshot,
  ListingRow,
  PurchaseEntitlementRow,
  PurchaseAllocationLegRow,
  PurchaseQuoteRow,
  PurchaseRow,
} from "./row-types"
import {
  parseQuoteAllocationSnapshot,
  serializePurchaseAllocationLeg,
} from "./allocation"
import {
  parseJsonValue,
} from "./row-types"

export function serializeAsset(row: AssetRow, input?: { redactPrimaryForLocked?: boolean }): Asset {
  const primaryContentRef = input?.redactPrimaryForLocked && row.access_mode === "locked"
    ? `locked:${row.asset_id}`
    : row.primary_content_ref
  return {
    asset_id: row.asset_id,
    community_id: row.community_id,
    source_post_id: row.source_post_id,
    display_title: row.display_title,
    song_artifact_bundle_id: row.song_artifact_bundle_id,
    creator_user_id: row.creator_user_id,
    asset_kind: row.asset_kind,
    rights_basis: row.rights_basis,
    access_mode: row.access_mode,
    license_preset: row.license_preset,
    commercial_rev_share_pct: row.commercial_rev_share_pct,
    primary_content_ref: primaryContentRef,
    primary_content_hash: row.primary_content_hash,
    publication_status: row.publication_status,
    story_status: row.story_status,
    story_error: row.story_error,
    story_ip_id: row.story_ip_id,
    story_ip_nft_contract: row.story_ip_nft_contract,
    story_ip_nft_token_id: row.story_ip_nft_token_id,
    story_publish_model: row.story_publish_model,
    story_license_terms_id: row.story_license_terms_id,
    story_license_template: row.story_license_template,
    story_royalty_policy: row.story_royalty_policy,
    story_royalty_policy_id: row.story_royalty_policy_id,
    story_derivative_parent_ip_ids: parseJsonValue(row.story_derivative_parent_ip_ids_json, null),
    story_derivative_registered_at: row.story_derivative_registered_at,
    story_revenue_token: row.story_revenue_token,
    story_royalty_registration_status: row.story_royalty_registration_status,
    story_publish_tx_ref: row.story_publish_tx_ref,
    story_asset_version_id: row.story_asset_version_id,
    story_cdr_vault_uuid: row.story_cdr_vault_uuid,
    story_namespace: row.story_namespace,
    story_entitlement_token_id: row.story_entitlement_token_id,
    story_read_condition: row.story_read_condition,
    story_write_condition: row.story_write_condition,
    locked_delivery_status: row.locked_delivery_status,
    locked_delivery_ref: row.locked_delivery_ref,
    locked_delivery_error: row.locked_delivery_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function parseListingPolicy(row: Pick<ListingRow, "regional_pricing_policy_json">): {
  regionalPricingEnabled: boolean
  donationPartnerId: string | null
  donationSharePct: number | null
} {
  const parsed = parseJsonValue<ListingPolicySnapshot>(row.regional_pricing_policy_json, {})
  return {
    regionalPricingEnabled: parsed.regional_pricing_enabled === true,
    donationPartnerId: typeof parsed.donation_partner_id === "string" && parsed.donation_partner_id.trim()
      ? parsed.donation_partner_id
      : null,
    donationSharePct: typeof parsed.donation_share_pct === "number" && Number.isFinite(parsed.donation_share_pct)
      ? parsed.donation_share_pct
      : null,
  }
}

export function serializeListing(row: ListingRow): CommunityListing {
  const policy = parseListingPolicy(row)
  return {
    listing_id: row.listing_id,
    community_id: row.community_id,
    asset_id: row.asset_id,
    live_room_id: row.live_room_id,
    listing_mode: row.listing_mode,
    status: row.status,
    price_usd: row.price_usd,
    regional_pricing_enabled: policy.regionalPricingEnabled,
    donation_partner_id: policy.donationPartnerId,
    donation_share_pct: policy.donationSharePct,
    created_by_user_id: row.created_by_user_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export function serializeQuote(row: PurchaseQuoteRow): CommunityPurchaseQuote {
  const settlementChain = parseJsonValue<CommunityPurchaseQuote["destination_settlement_chain"]>(
    row.destination_settlement_chain_json,
    { chain_namespace: "eip155", chain_id: 1315, display_name: "Story Aeneid" },
  )
  return {
    quote_id: row.quote_id,
    community_id: row.community_id,
    listing_id: row.listing_id,
    buyer_user_id: row.buyer_user_id,
    asset_id: row.asset_id,
    live_room_id: row.live_room_id,
    base_price_usd: row.base_price_usd,
    pricing_tier: row.pricing_tier,
    final_price_usd: row.final_price_usd,
    settlement_mode: row.settlement_mode,
    allocation_snapshot: parseQuoteAllocationSnapshot(row.allocation_snapshot_json),
    funding_mode: row.funding_mode,
    funding_asset: parseJsonValue(row.funding_asset_json, null),
    source_chain: parseJsonValue(row.source_chain_json, null),
    route_provider: row.route_provider,
    route_policy_compliant: row.route_policy_compliant,
    route_live_available: row.route_live_available,
    policy_origin: row.policy_origin,
    destination_settlement_chain: settlementChain,
    destination_settlement_token: row.destination_settlement_token,
    destination_settlement_amount_atomic: row.destination_settlement_amount_atomic,
    destination_settlement_decimals: row.destination_settlement_decimals,
    funding_destination_address: row.funding_destination_address,
    treasury_denomination: row.treasury_denomination,
    quote_ttl_seconds: row.quote_ttl_seconds,
    route_required: row.route_required,
    route_status_policy: row.route_status_policy,
    route_hop_tolerance: row.route_hop_tolerance,
    verification_snapshot_ref: row.verification_snapshot_ref,
    pricing_policy_version: row.pricing_policy_version,
    quoted_at: row.quoted_at,
    expires_at: row.expires_at,
  }
}

export function serializePurchase(
  row: PurchaseRow,
  entitlement: PurchaseEntitlementRow,
  allocations: PurchaseAllocationLegRow[],
): CommunityPurchase {
  const settlementChain = parseJsonValue<CommunityPurchase["settlement_chain"]>(
    row.settlement_chain,
    { chain_namespace: "eip155", chain_id: 1315, display_name: "Story Aeneid" },
  )
  return {
    purchase_id: row.purchase_id,
    community_id: row.community_id,
    listing_id: row.listing_id,
    asset_id: row.asset_id,
    live_room_id: row.live_room_id,
    buyer_user_id: row.buyer_user_id,
    settlement_wallet_attachment_id: row.settlement_wallet_attachment_id,
    purchase_price_usd: row.purchase_price_usd,
    pricing_tier: row.pricing_tier,
    settlement_mode: row.settlement_mode,
    settlement_chain: settlementChain,
    settlement_token: row.settlement_token,
    settlement_tx_ref: row.settlement_tx_ref,
    allocations: allocations.map(serializePurchaseAllocationLeg),
    donation_partner_id: row.donation_partner_id,
    donation_share_pct: row.donation_share_pct,
    donation_amount_usd: row.donation_amount_usd,
    purchase_entitlement_id: entitlement.purchase_entitlement_id,
    entitlement_kind: entitlement.entitlement_kind,
    entitlement_target_ref: entitlement.target_ref,
    created_at: row.created_at,
  }
}
