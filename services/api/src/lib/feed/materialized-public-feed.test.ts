import { describe, expect, test } from "bun:test"

import type { Client } from "../sql-client"
import {
  buildMaterializedPublicHomeFeedTarget,
  readMaterializedPublicHomeFeed,
} from "./materialized-public-feed"
import { VIDEO_SCORER_VERSION } from "./video-scorer"

function clientWithRow(row: Record<string, unknown>): Client {
  return {
    batch: async () => [],
    execute: async () => ({ rows: [row] }),
    transaction: async () => {
      throw new Error("not used")
    },
  }
}

const target = buildMaterializedPublicHomeFeedTarget({
  locale: "en",
  sort: "best",
  timeRange: "all",
})

function cachedRow(staleAt: string): Record<string, unknown> {
  return {
    expires_at: "2026-07-20T07:00:00.000Z",
    json_body: JSON.stringify({ items: [], next_cursor: null, top_communities: [] }),
    stale_at: staleAt,
  }
}

describe("readMaterializedPublicHomeFeed", () => {
  test("versions video snapshots with the scorer while leaving mixed-feed keys stable", () => {
    const videoTarget = buildMaterializedPublicHomeFeedTarget({
      contentKind: "video",
      locale: "en",
      sort: "best",
      timeRange: "all",
    })
    expect(videoTarget?.cacheKey).toContain(`scorer=${VIDEO_SCORER_VERSION}`)
    expect(target?.cacheKey).not.toContain("scorer=")
  })

  test("pins video snapshot cache keys to the scorer", () => {
    const scorerTarget = buildMaterializedPublicHomeFeedTarget({
      contentKind: "video",
      locale: "en",
    })
    expect(scorerTarget?.cacheKey).toContain("ranking=scorer")
    expect(scorerTarget?.cacheKey).toContain(`scorer=${VIDEO_SCORER_VERSION}`)
  })

  test("serves an expired snapshot during the bounded outage grace", async () => {
    const result = await readMaterializedPublicHomeFeed({
      client: clientWithRow(cachedRow("2026-07-20T07:30:00.000Z")),
      nowMs: Date.parse("2026-07-20T08:30:00.000Z"),
      target,
    })

    expect(result.state).toBe("stale")
    expect(result.result).not.toBeNull()
  })

  test("rejects an expired snapshot after the outage grace", async () => {
    const result = await readMaterializedPublicHomeFeed({
      client: clientWithRow(cachedRow("2026-07-20T07:30:00.000Z")),
      nowMs: Date.parse("2026-07-20T09:30:00.001Z"),
      target,
    })

    expect(result).toEqual({ result: null, state: "miss" })
  })
})
