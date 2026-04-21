import { describe, expect, test } from "bun:test"
import {
  assertExecutableQuoteAllocationSnapshot,
  extractDonationCompatibilityFields,
  resolveQuoteAllocationSnapshot,
} from "../src/lib/communities/commerce/allocation"

describe("community commerce allocation", () => {
  test("builds a creator-only allocation snapshot when no donation partner is configured", () => {
    const snapshot = assertExecutableQuoteAllocationSnapshot(
      resolveQuoteAllocationSnapshot({
        finalPriceUsd: 1,
        listingPolicy: {
          donationPartnerId: null,
          donationSharePct: null,
        },
      }),
    )

    expect(snapshot).toEqual([
      {
        recipient_type: "creator",
        recipient_ref: null,
        waterfall_position: 70,
        share_bps: 10_000,
        amount_usd: 1,
        settlement_strategy: "story_payout",
      },
    ])
    expect(extractDonationCompatibilityFields({ allocationSnapshot: snapshot })).toEqual({
      donationPartnerId: null,
      donationSharePct: null,
      donationAmountUsd: null,
    })
  })

  test("rounds charity first and gives the creator the remainder", () => {
    const snapshot = assertExecutableQuoteAllocationSnapshot(
      resolveQuoteAllocationSnapshot({
        finalPriceUsd: 0.1,
        listingPolicy: {
          donationPartnerId: "don_charity_water",
          donationSharePct: 10,
        },
      }),
    )

    expect(snapshot).toEqual([
      {
        recipient_type: "charity",
        recipient_ref: "don_charity_water",
        waterfall_position: 60,
        share_bps: 1000,
        amount_usd: 0.01,
        settlement_strategy: "provider_payout",
      },
      {
        recipient_type: "creator",
        recipient_ref: null,
        waterfall_position: 70,
        share_bps: 9000,
        amount_usd: 0.09,
        settlement_strategy: "story_payout",
      },
    ])
    expect(extractDonationCompatibilityFields({ allocationSnapshot: snapshot })).toEqual({
      donationPartnerId: "don_charity_water",
      donationSharePct: 10,
      donationAmountUsd: 0.01,
    })
  })
})
