import { describe, expect, test } from "bun:test"

import type { Client } from "../sql-client"
import {
  buildMaterializedPublicHomeFeedTarget,
  readMaterializedPublicHomeFeed,
} from "./materialized-public-feed"

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
