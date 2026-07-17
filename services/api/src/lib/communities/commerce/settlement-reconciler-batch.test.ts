import { describe, expect, test } from "bun:test"

import {
  listPurchaseSettlementReconciliationCommunities,
  selectRotatingCommunityBatch,
} from "./settlement-service"

describe("purchase settlement reconciliation community batching", () => {
  test("keeps the per-run bound while covering communities beyond the oldest 100", () => {
    const communities = Array.from({ length: 244 }, (_, index) => `community_${index}`)
    const minute = 1_000
    const batches = Array.from({ length: 3 }, (_, offset) =>
      selectRotatingCommunityBatch(communities, 100, (minute + offset) * 60_000))

    expect(batches.every((batch) => batch.length === 100)).toBe(true)
    expect(new Set(batches.flat())).toEqual(new Set(communities))
    expect(batches.some((batch) => batch.includes("community_176"))).toBe(true)
  })

  test("returns every community when the fleet fits in one batch", () => {
    const communities = ["community_1", "community_2"]
    expect(selectRotatingCommunityBatch(communities, 100, Date.now())).toEqual(communities)
  })

  test("enumerates authoritative ready routes without consulting active community lifecycle", async () => {
    let routedCalls = 0
    const communities = await listPurchaseSettlementReconciliationCommunities({
      listSettlementEligibleCommunities: async () => {
        routedCalls += 1
        return [{ community_id: "canary_inactive", created_at: "2026-07-17T00:00:00.000Z" }]
      },
    }, 100, 0)

    expect(routedCalls).toBe(1)
    expect(communities.map((community) => community.community_id)).toEqual(["canary_inactive"])
  })
})
