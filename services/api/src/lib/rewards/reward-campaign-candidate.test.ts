import { describe, expect, test } from "bun:test"

import {
  listRewardCampaignCommunityIds,
  scheduleRewardCampaignCommunityIds,
} from "./reward-campaign-candidates"

describe("reward campaign ingestion candidates", () => {
  test("uses the seven-day post-end credit window without filtering campaign status", async () => {
    let query = ""
    let args: unknown[] = []
    const ids = await listRewardCampaignCommunityIds({
      postgres: false,
      now: "2026-08-07T12:00:00.000Z",
      client: {
        execute: async (statement) => {
          if (typeof statement === "string") throw new Error("expected_candidate_query_statement")
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

  test("rotates the scoped candidates before applying the per-tick cap", () => {
    expect(scheduleRewardCampaignCommunityIds(
      ["cmt_a", "cmt_b", "cmt_c", "cmt_d"],
      2,
      "1970-01-01T00:01:00.000Z",
    )).toEqual(["cmt_b", "cmt_c"])
  })
})
