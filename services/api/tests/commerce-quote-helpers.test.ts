import { describe, expect, test } from "bun:test"
import type { CommunityListing, CommunityPricingPolicy } from "../src/types"

import {
  resolveBestVerifiedRegionalPrice,
  resolvePurchaseEntitlementTarget,
} from "../src/lib/communities/commerce/quote-helpers"

function createListing(overrides: Partial<CommunityListing> = {}): CommunityListing {
  return {
    id: "lst_test",
    object: "community_listing",
    community: "com_cmt_test",
    listing_mode: "fixed_price",
    status: "active",
    price_cents: 1000,
    regional_pricing_enabled: true,
    created_by_user: "usr_creator",
    created: 1767225600,
    ...overrides,
  }
}

function createPricingPolicy(overrides: Partial<CommunityPricingPolicy> = {}): CommunityPricingPolicy {
  return {
    id: "cpp_cmt_test",
    object: "community_pricing_policy",
    policy_origin: "explicit",
    pricing_policy_version: "ppv_test",
    regional_pricing_enabled: true,
    verification_provider_requirement: "self",
    default_tier_key: "starter",
    tiers: [
      { adjustment_type: "multiplier", adjustment_value: 0.8, display_name: "Starter", tier_key: "starter" },
      { adjustment_type: "multiplier", adjustment_value: 0.5, display_name: "Access", tier_key: "access" },
    ],
    country_assignments: [
      { country_code: "BR", tier_key: "access" },
    ],
    ...overrides,
  }
}

describe("resolveBestVerifiedRegionalPrice", () => {
  test("returns the strongest Self discount from the listing pricing policy", () => {
    expect(resolveBestVerifiedRegionalPrice({
      listing: createListing(),
      pricingPolicy: createPricingPolicy(),
    })).toEqual({
      bestVerifiedPriceUsd: 5,
      maxSelfDiscountPercent: 50,
      verificationRequiredProvider: "self",
    })
  })

  test("does not offer a Self discount when regional pricing is unavailable", () => {
    expect(resolveBestVerifiedRegionalPrice({
      listing: createListing({ regional_pricing_enabled: false }),
      pricingPolicy: createPricingPolicy(),
    })).toEqual({
      bestVerifiedPriceUsd: null,
      maxSelfDiscountPercent: null,
      verificationRequiredProvider: null,
    })
  })

  test("does not offer a discount when reachable tiers do not reduce the price", () => {
    expect(resolveBestVerifiedRegionalPrice({
      listing: createListing(),
      pricingPolicy: createPricingPolicy({
        default_tier_key: "premium",
        tiers: [
          { adjustment_type: "multiplier", adjustment_value: 1.25, display_name: "Premium", tier_key: "premium" },
        ],
        country_assignments: [],
      }),
    })).toEqual({
      bestVerifiedPriceUsd: 10,
      maxSelfDiscountPercent: null,
      verificationRequiredProvider: "self",
    })
  })

  test("does not offer a discount when no pricing tier can be reached", () => {
    expect(resolveBestVerifiedRegionalPrice({
      listing: createListing(),
      pricingPolicy: createPricingPolicy({
        default_tier_key: null,
        country_assignments: [],
      }),
    })).toEqual({
      bestVerifiedPriceUsd: null,
      maxSelfDiscountPercent: null,
      verificationRequiredProvider: null,
    })
  })

  test("does not offer a discount for invalid listing price", () => {
    expect(resolveBestVerifiedRegionalPrice({
      listing: createListing({ price_cents: 0 }),
      pricingPolicy: createPricingPolicy(),
    })).toEqual({
      bestVerifiedPriceUsd: null,
      maxSelfDiscountPercent: null,
      verificationRequiredProvider: null,
    })
  })

  test("defaults the pricing verification provider to Self when policy omits it", () => {
    expect(resolveBestVerifiedRegionalPrice({
      listing: createListing(),
      pricingPolicy: createPricingPolicy({ verification_provider_requirement: null }),
    })).toEqual({
      bestVerifiedPriceUsd: 5,
      maxSelfDiscountPercent: 50,
      verificationRequiredProvider: "self",
    })
  })
})

describe("resolvePurchaseEntitlementTarget", () => {
  test("targets assets when a quote is for an asset listing", () => {
    expect(resolvePurchaseEntitlementTarget({
      asset_id: "ast_asset",
      live_room_id: null,
      listing_id: "lst_listing",
    })).toEqual({
      entitlementKind: "asset_access",
      targetRef: "ast_asset",
    })
  })

  test("targets live rooms when a quote is for a live-room listing", () => {
    expect(resolvePurchaseEntitlementTarget({
      asset_id: null,
      live_room_id: "lr_room",
      listing_id: "lst_listing",
    })).toEqual({
      entitlementKind: "live_room_access",
      targetRef: "lr_room",
    })
  })
})
