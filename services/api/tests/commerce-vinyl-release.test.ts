import { describe, expect, test } from "bun:test"

import {
  parseListingPolicy,
  serializeListing,
  serializePurchase,
} from "../src/lib/communities/commerce/serialization"
import { normalizeElasticStageReleaseUrl } from "../src/lib/communities/commerce/listing-service"
import { serializeSettlement } from "../src/lib/communities/commerce/quote-helpers"
import type {
  ListingRow,
  PurchaseEntitlementRow,
  PurchaseQuoteRow,
  PurchaseRow,
} from "../src/lib/communities/commerce/row-types"

const createdAt = "2026-05-16T09:00:00.000Z"
const vinylPolicyJson = JSON.stringify({
  regional_pricing_enabled: true,
  vinyl_release_provider: "elasticstage",
  vinyl_release_url: "  https://elasticstage.com/saint-pablo/releases/benefit-single  ",
})

function createListingRow(overrides: Partial<ListingRow> = {}): ListingRow {
  return {
    listing_id: "lst_song",
    community_id: "cmt_songs",
    asset_id: "ast_song",
    live_room_id: null,
    listing_mode: "fixed_price",
    status: "active",
    price_usd: 7,
    regional_pricing_policy_json: null,
    created_by_user_id: "usr_artist",
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  }
}

function createPurchaseRow(overrides: Partial<PurchaseRow> = {}): PurchaseRow {
  return {
    purchase_id: "pur_song",
    community_id: "cmt_songs",
    listing_id: "lst_song",
    asset_id: "ast_song",
    live_room_id: null,
    buyer_kind: "user",
    buyer_user_id: "usr_fan",
    buyer_wallet_address: null,
    buyer_wallet_address_normalized: null,
    buyer_chain_ref: null,
    settlement_wallet_attachment_id: "wa_fan",
    purchase_price_usd: 7,
    pricing_tier: null,
    settlement_mode: "delivery_only_story_settlement",
    settlement_chain: JSON.stringify({ chain_namespace: "eip155", chain_id: 1315, display_name: "Story Aeneid" }),
    settlement_token: "IP",
    settlement_tx_ref: "0xabc",
    donation_partner_id: null,
    donation_share_pct: null,
    donation_amount_usd: null,
    listing_policy_json: null,
    created_at: createdAt,
    ...overrides,
  }
}

function createEntitlementRow(overrides: Partial<PurchaseEntitlementRow> = {}): PurchaseEntitlementRow {
  return {
    purchase_entitlement_id: "pe_song",
    purchase_id: "pur_song",
    community_id: "cmt_songs",
    buyer_kind: "user",
    buyer_user_id: "usr_fan",
    buyer_wallet_address: null,
    buyer_wallet_address_normalized: null,
    buyer_chain_ref: null,
    entitlement_kind: "asset_access",
    target_ref: "ast_song",
    status: "active",
    granted_at: createdAt,
    revoked_at: null,
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  }
}

function createQuoteRow(overrides: Partial<PurchaseQuoteRow> = {}): PurchaseQuoteRow {
  return {
    quote_id: "pq_song",
    community_id: "cmt_songs",
    listing_id: "lst_song",
    buyer_kind: "user",
    buyer_user_id: "usr_fan",
    buyer_wallet_address: null,
    buyer_wallet_address_normalized: null,
    buyer_chain_ref: null,
    asset_id: "ast_song",
    live_room_id: null,
    base_price_usd: 7,
    pricing_tier: null,
    final_price_usd: 7,
    allocation_snapshot_json: "[]",
    funding_mode: "routed",
    funding_asset_json: null,
    source_chain_json: null,
    route_provider: "pirate_checkout",
    funding_destination_address: null,
    route_policy_compliant: true,
    route_live_available: null,
    policy_origin: "explicit",
    destination_settlement_chain_json: JSON.stringify({ chain_namespace: "eip155", chain_id: 1315, display_name: "Story Aeneid" }),
    destination_settlement_token: "IP",
    destination_settlement_amount_atomic: null,
    destination_settlement_decimals: null,
    treasury_denomination: null,
    quote_ttl_seconds: 60,
    route_required: true,
    route_status_policy: "fail",
    route_hop_tolerance: 0,
    settlement_mode: "delivery_only_story_settlement",
    verification_snapshot_ref: null,
    pricing_policy_version: null,
    status: "consumed",
    quoted_at: createdAt,
    expires_at: "2026-05-16T09:01:00.000Z",
    consumed_at: createdAt,
    failed_at: null,
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
  }
}

describe("commerce vinyl release serialization", () => {
  test("accepts ElasticStage HTTPS release URLs with loose release path matching", () => {
    expect(normalizeElasticStageReleaseUrl(
      " https://www.elasticstage.com/saint-pablo/releases/benefit-single?variant=black#details ",
    )).toBe("https://www.elasticstage.com/saint-pablo/releases/benefit-single?variant=black")

    expect(() => normalizeElasticStageReleaseUrl(
      "https://elasticstage.com/saint-pablo/release/benefit-single",
    )).toThrow("vinyl_release_url must be an ElasticStage release URL")
    expect(() => normalizeElasticStageReleaseUrl(
      "http://elasticstage.com/saint-pablo/releases/benefit-single",
    )).toThrow("vinyl_release_url must be an ElasticStage HTTPS URL")
  })

  test("exposes vinyl availability on listings without leaking the URL", () => {
    const policy = parseListingPolicy({ regional_pricing_policy_json: vinylPolicyJson })
    expect(policy.vinylReleaseProvider).toBe("elasticstage")
    expect(policy.vinylReleaseUrl).toBe("https://elasticstage.com/saint-pablo/releases/benefit-single")

    const listing = serializeListing(createListingRow({ regional_pricing_policy_json: vinylPolicyJson }))
    expect(listing.vinyl_release_available).toBe(true)
    expect(listing.vinyl_release_provider).toBe("elasticstage")
    expect("vinyl_release_url" in listing).toBe(false)
  })

  test("exposes the vinyl URL only on owned purchase and settlement responses", () => {
    const purchaseRow = createPurchaseRow({ listing_policy_json: vinylPolicyJson })
    const entitlementRow = createEntitlementRow()
    const quoteRow = createQuoteRow()

    const purchase = serializePurchase(purchaseRow, entitlementRow, [])
    expect(purchase.vinyl_release_provider).toBe("elasticstage")
    expect(purchase.vinyl_release_url).toBe("https://elasticstage.com/saint-pablo/releases/benefit-single")

    const settlement = serializeSettlement(purchaseRow, entitlementRow, quoteRow, [])
    expect(settlement.vinyl_release_provider).toBe("elasticstage")
    expect(settlement.vinyl_release_url).toBe("https://elasticstage.com/saint-pablo/releases/benefit-single")
  })
})
