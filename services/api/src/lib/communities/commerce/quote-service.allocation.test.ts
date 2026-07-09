import { describe, expect, test } from "bun:test"

import { resolveReplayQuoteAllocationSnapshot } from "./quote-service"

type ReplayAllocation = Parameters<typeof resolveReplayQuoteAllocationSnapshot>[0]["replayAllocations"][number]

function replayAllocation(shareBps: number, index: number): ReplayAllocation {
  return {
    allocation_id: `lra_${index}`,
    replay_asset_id: "lra_asset",
    community_id: "cmt_test",
    participant_user_id: `usr_${index}`,
    external_party_ref: null,
    role: "performer",
    share_bps: shareBps,
    rights_basis: "performer_default",
    approval_status: "approved",
    created_at: "2026-07-09T00:00:00.000Z",
    updated_at: "2026-07-09T00:00:00.000Z",
  }
}

function saleSharesToWalletBps(input: {
  charityShareBps: number
  walletSaleShareBps: number[]
}): number[] {
  const remainingWalletBps = 10_000 - input.charityShareBps
  let allocatedWalletBps = 0
  return input.walletSaleShareBps.map((saleShareBps, index) => {
    const isLast = index === input.walletSaleShareBps.length - 1
    const walletBps = isLast
      ? 10_000 - allocatedWalletBps
      : Math.round((saleShareBps / remainingWalletBps) * 10_000)
    allocatedWalletBps += walletBps
    return walletBps
  })
}

describe("resolveReplayQuoteAllocationSnapshot charity split scaling", () => {
  test("round-trips displayed sale-proceeds wallet shares through wallet-normalized bps", () => {
    const cases = [
      { charityShareBps: 1_000, walletSaleShareBps: [6_300, 2_700] },
      { charityShareBps: 700, walletSaleShareBps: [3_100, 3_100, 3_100] },
      { charityShareBps: 900, walletSaleShareBps: [3_033, 3_033, 3_034] },
      { charityShareBps: 5_000, walletSaleShareBps: [1_667, 1_666, 1_667] },
    ]

    for (const testCase of cases) {
      const replayAllocations = saleSharesToWalletBps(testCase)
        .map((shareBps, index) => replayAllocation(shareBps, index))
      const snapshot = resolveReplayQuoteAllocationSnapshot({
        finalPriceUsd: 10,
        replayAllocations,
        listingPolicy: {
          donationPartnerId: "don_charity",
          donationSharePct: testCase.charityShareBps / 100,
        },
      })
      const walletSnapshot = snapshot.filter((allocation) => allocation.recipient_type === "performer")
      expect(walletSnapshot.map((allocation) => allocation.share_bps)).toEqual(testCase.walletSaleShareBps)
      expect(snapshot.reduce((sum, allocation) => sum + allocation.share_bps, 0)).toBe(10_000)
    }
  })
})
