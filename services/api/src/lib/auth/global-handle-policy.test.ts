import { describe, expect, test } from "bun:test"

import {
  GLOBAL_HANDLE_PAID_POLICY_VERSION,
  buildHandleUpgradeQuote,
  normalizeDesiredGlobalHandleLabel,
  resolveGlobalHandlePaidPrice,
} from "./global-handle-policy"

describe("global handle paid policy", () => {
  test("uses the accessible v2 base curve", () => {
    expect(resolveGlobalHandlePaidPrice({ labelNormalized: "longname" }).priceCents).toBe(500)
    expect(resolveGlobalHandlePaidPrice({ labelNormalized: "sevennn" }).priceCents).toBe(1_000)
    expect(resolveGlobalHandlePaidPrice({ labelNormalized: "sixsix" }).priceCents).toBe(2_500)
    expect(resolveGlobalHandlePaidPrice({ labelNormalized: "fives" }).priceCents).toBe(5_000)
    expect(resolveGlobalHandlePaidPrice({ labelNormalized: "four" }).priceCents).toBe(10_000)
    expect(resolveGlobalHandlePaidPrice({ labelNormalized: "abc" }).priceCents).toBe(25_000)
  })

  test("applies exact premium terms and clean price bands", () => {
    expect(resolveGlobalHandlePaidPrice({ labelNormalized: "olivia" })).toMatchObject({
      priceCents: 25_000,
      pricingTier: "first_name",
      policyVersion: GLOBAL_HANDLE_PAID_POLICY_VERSION,
    })
    expect(resolveGlobalHandlePaidPrice({ labelNormalized: "captain" })).toMatchObject({
      priceCents: 2_500,
      pricingTier: "common_word",
    })
  })

  test("prices exact-match prestige and obvious valuable terms", () => {
    expect(resolveGlobalHandlePaidPrice({ labelNormalized: "king" })).toMatchObject({
      priceCents: 100_000,
      pricingTier: "trophy",
    })
    expect(resolveGlobalHandlePaidPrice({ labelNormalized: "queen" })).toMatchObject({
      priceCents: 50_000,
      pricingTier: "trophy",
    })
    expect(resolveGlobalHandlePaidPrice({ labelNormalized: "sheikh" })).toMatchObject({
      priceCents: 25_000,
      pricingTier: "trophy",
    })
    expect(resolveGlobalHandlePaidPrice({ labelNormalized: "crown" })).toMatchObject({
      priceCents: 50_000,
      pricingTier: "trophy",
    })
    expect(resolveGlobalHandlePaidPrice({ labelNormalized: "tax" })).toMatchObject({
      priceCents: 500_000,
      pricingTier: "commercial_keyword",
    })
  })

  test("discounts hyphenated and numbered labels after premium matching", () => {
    expect(resolveGlobalHandlePaidPrice({ labelNormalized: "my-name" })).toMatchObject({
      priceCents: 500,
      pricingTier: "discounted",
    })
    expect(resolveGlobalHandlePaidPrice({ labelNormalized: "name123" })).toMatchObject({
      priceCents: 1_000,
      pricingTier: "discounted",
    })
  })

  test("reserves exact reserved labels and prices commercial terms through the multiplier layer", () => {
    expect(resolveGlobalHandlePaidPrice({ labelNormalized: "pirate" })).toMatchObject({
      eligible: false,
      reason: "Desired label is reserved",
      pricingTier: "reserved",
    })
    expect(resolveGlobalHandlePaidPrice({ labelNormalized: "loan" })).toMatchObject({
      eligible: true,
      priceCents: 500_000,
      pricingTier: "commercial_keyword",
    })
  })

  test("normalizes emoji labels to punycode for reserve checks", () => {
    const desired = normalizeDesiredGlobalHandleLabel("👑")
    expect(desired.labelNormalized).toBe("xn--2p8h")
    expect(buildHandleUpgradeQuote({
      desiredLabel: desired.labelDisplay,
      labelNormalized: desired.labelNormalized,
      currentActiveLabelNormalized: "current",
      cleanupRenameAvailable: false,
      labelAvailable: true,
    })).toMatchObject({
      eligible: false,
      reason: "Desired label is reserved",
    })
  })
})
