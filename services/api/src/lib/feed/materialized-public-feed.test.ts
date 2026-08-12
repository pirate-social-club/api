import { describe, expect, spyOn, test } from "bun:test"

import type { Client } from "../sql-client"
import {
  buildMaterializedPublicHomeFeedTarget,
  readMaterializedPublicHomeFeed,
  storeMaterializedPublicHomeFeed,
} from "./materialized-public-feed"
import type { Env, HomeFeedResponse } from "../../types"
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

  test("emits a weighted sampled observation for cache hits", async () => {
    const random = spyOn(Math, "random").mockReturnValue(0)
    const log = spyOn(console, "log").mockImplementation(() => {})
    try {
      const result = await readMaterializedPublicHomeFeed({
        client: clientWithRow({
          ...cachedRow("2026-07-20T08:30:00.000Z"),
          expires_at: "2026-07-20T08:00:00.000Z",
        }),
        nowMs: Date.parse("2026-07-20T07:30:00.000Z"),
        target,
      })

      expect(result.state).toBe("hit")
      expect(log).toHaveBeenCalledTimes(1)
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
        event: "cache_hit",
        metric: "materialized_public_feed",
        sample_rate: 1 / 256,
        value: 256,
      })
    } finally {
      log.mockRestore()
      random.mockRestore()
    }
  })

  test("does not log an ordinary cache outcome outside the sample", async () => {
    const random = spyOn(Math, "random").mockReturnValue(0.5)
    const log = spyOn(console, "log").mockImplementation(() => {})
    try {
      const result = await readMaterializedPublicHomeFeed({
        client: clientWithRow({
          ...cachedRow("2026-07-20T08:30:00.000Z"),
          expires_at: "2026-07-20T08:00:00.000Z",
        }),
        nowMs: Date.parse("2026-07-20T07:30:00.000Z"),
        target,
      })

      expect(result.state).toBe("hit")
      expect(log).not.toHaveBeenCalled()
    } finally {
      log.mockRestore()
      random.mockRestore()
    }
  })

  test("makes a missing cache table visible as a structured error observation", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {})
    try {
      const result = await readMaterializedPublicHomeFeed({
        client: {
          ...clientWithRow({}),
          execute: async () => {
            throw new Error("no such table: materialized_public_feeds")
          },
        },
        target,
      })

      expect(result).toEqual({ result: null, state: "error" })
      expect(error).toHaveBeenCalledTimes(1)
      expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
        error_kind: "missing_relation",
        event: "cache_error",
        operation: "read",
        sample_rate: 1,
        value: 1,
      })
    } finally {
      error.mockRestore()
    }
  })

  test("makes a missing cache table visible when a snapshot store fails", async () => {
    const error = spyOn(console, "error").mockImplementation(() => {})
    try {
      await storeMaterializedPublicHomeFeed({
        client: {
          ...clientWithRow({}),
          execute: async () => {
            throw new Error("no such table: materialized_public_feeds")
          },
        },
        env: {} as Env,
        result: { items: [], next_cursor: null, top_communities: [] } as HomeFeedResponse,
        target,
      })

      expect(error).toHaveBeenCalledTimes(1)
      expect(JSON.parse(String(error.mock.calls[0]?.[0]))).toMatchObject({
        error_kind: "missing_relation",
        event: "store_error",
        operation: "store",
        sample_rate: 1,
        value: 1,
      })
    } finally {
      error.mockRestore()
    }
  })
})
