import { describe, expect, test } from "bun:test"

import { listRewardCampaignCommunityIds } from "./reward-campaign-candidates"

describe("reward campaign ingestion candidates", () => {
  test("uses the seven-day post-end credit window without filtering campaign status", async () => {
    let query = ""
    let args: unknown[] = []
    const ids = await listRewardCampaignCommunityIds({
      postgres: false,
      now: "2026-08-07T12:00:00.000Z",
      client: {
        execute: async (statement) => {
          query = statement.sql
          args = statement.args ?? []
          return { rows: [
            { community_id: "cmt_exhausted" },
            { community_id: "cmt_ended" },
            { community_id: null },
          ] }
        },
      },
    })

    expect(args).toEqual(["2026-07-31T12:00:00.000Z"])
    expect(query).toContain("ends_at >= CAST(?1 AS TEXT)")
    expect(query).not.toContain("status")
    expect(ids).toEqual(["cmt_exhausted", "cmt_ended"])
  })
})
