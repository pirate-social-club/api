import { describe, expect, test } from "bun:test"
import type { CommunityListing, CommunityPricingPolicy } from "../src/types"

import { resolveBestVerifiedRegionalPrice } from "../src/lib/communities/commerce/quote-helpers"

function createListing(overrides: Partial<CommunityListing> = {}): CommunityListing {
  return {
    listing_id: "lst_test",
    community_id: "cmt_test",
    listing_mode: "fixed_price",
    status: "active",
    price_usd: 10,
    regional_pricing_enabled: true,
    created_by_user_id: "usr_creator",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }
}

function createPricingPolicy(overrides: Partial<CommunityPricingPolicy> = {}): CommunityPricingPolicy {
  return {
    community_id: "cmt_test",
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
    updated_at: "2026-01-01T00:00:00.000Z",
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
      listing: createListing({ price_usd: 0 }),
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
