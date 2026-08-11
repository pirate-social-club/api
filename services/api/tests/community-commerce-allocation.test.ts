import { describe, expect, test } from "bun:test"
import {
  assertExecutableQuoteAllocationSnapshot,
  extractDonationFields,
  resolveQuoteAllocationSnapshot,
} from "../src/lib/communities/commerce/allocation"

describe("community commerce allocation", () => {
  test("builds a creator-only allocation snapshot when no donation partner is configured", () => {
    const snapshot = assertExecutableQuoteAllocationSnapshot(
      resolveQuoteAllocationSnapshot({
        finalPriceCents: 100,
        listingPolicy: {
          donationPartnerId: null,
          donationShareBps: null,
        },
      }),
    )

    expect(snapshot).toEqual([
      {
        recipient_type: "creator",
        recipient_ref: null,
        waterfall_position: 70,
        share_bps: 10_000,
        amount_cents: 100,
        settlement_strategy: "story_payout",
      },
    ])
    expect(extractDonationFields({ allocationSnapshot: snapshot })).toEqual({
      donationPartnerId: null,
      donationShareBps: null,
      donationAmountCents: null,
    })
  })

  test("rounds charity first and gives the creator the remainder", () => {
    const snapshot = assertExecutableQuoteAllocationSnapshot(
      resolveQuoteAllocationSnapshot({
        finalPriceCents: 10,
        listingPolicy: {
          donationPartnerId: "don_charity_water",
          donationShareBps: 1000,
        },
      }),
    )

    expect(snapshot).toEqual([
      {
        recipient_type: "charity",
        recipient_ref: "don_charity_water",
        waterfall_position: 60,
        share_bps: 1000,
        amount_cents: 1,
        settlement_strategy: "provider_payout",
      },
      {
        recipient_type: "creator",
        recipient_ref: null,
        waterfall_position: 70,
        share_bps: 9000,
        amount_cents: 9,
        settlement_strategy: "story_payout",
      },
    ])
    expect(extractDonationFields({ allocationSnapshot: snapshot })).toEqual({
      donationPartnerId: "don_charity_water",
      donationShareBps: 1000,
      donationAmountCents: 1,
    })
  })
})
