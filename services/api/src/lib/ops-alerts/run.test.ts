import { describe, expect, test } from "bun:test"
import { selectCommunityIdsForOpsAlertScan } from "./run"

describe("selectCommunityIdsForOpsAlertScan", () => {
  test("returns all communities sorted when under the scan limit", () => {
    expect(selectCommunityIdsForOpsAlertScan({
      communityIds: ["c3", "c1", "c2", "c2"],
      maxCommunities: 10,
      nowMs: 0,
    })).toEqual({
      selected: ["c1", "c2", "c3"],
      offset: 0,
      truncated: false,
    })
  })

  test("rotates the truncated scan window by time and wraps at the end", () => {
    const communityIds = ["c4", "c1", "c5", "c2", "c3"]

    expect(selectCommunityIdsForOpsAlertScan({
      communityIds,
      maxCommunities: 2,
      nowMs: 0,
    })).toEqual({
      selected: ["c1", "c2"],
      offset: 0,
      truncated: true,
    })

    expect(selectCommunityIdsForOpsAlertScan({
      communityIds,
      maxCommunities: 2,
      nowMs: 60_000,
    })).toEqual({
      selected: ["c3", "c4"],
      offset: 2,
      truncated: true,
    })

    expect(selectCommunityIdsForOpsAlertScan({
      communityIds,
      maxCommunities: 2,
      nowMs: 120_000,
    })).toEqual({
      selected: ["c5", "c1"],
      offset: 4,
      truncated: true,
    })
  })

  test("covers every community across successive rotated windows", () => {
    const communityIds = Array.from({ length: 11 }, (_, index) => `c${String(index).padStart(2, "0")}`)
    const seen = new Set<string>()

    for (let minute = 0; minute < 6; minute += 1) {
      const { selected } = selectCommunityIdsForOpsAlertScan({
        communityIds,
        maxCommunities: 2,
        nowMs: minute * 60_000,
      })
      for (const id of selected) seen.add(id)
    }

    expect([...seen].sort()).toEqual(communityIds)
  })
})
