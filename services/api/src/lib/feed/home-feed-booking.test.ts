import { describe, expect, test } from "bun:test"

import type { HomeFeedItem } from "../../types"
import {
  decorateHomeFeedItemsWithBookings,
  listFeedBookingsByHostUserIds,
  type FeedBookingExecutor,
} from "./home-feed-booking"

function feedItem(input: {
  authorUser?: string | null
  authorshipMode?: "human_direct" | "user_agent"
  identityMode?: "public" | "anonymous"
  id?: string
} = {}): HomeFeedItem {
  return {
    community: {
      id: "com_test",
      object: "home_feed_community_summary",
      display_name: "Test",
    },
    post: {
      post: {
        id: input.id ?? "post_test",
        author_user: input.authorUser === undefined ? "usr_host" : input.authorUser,
        authorship_mode: input.authorshipMode ?? "human_direct",
        identity_mode: input.identityMode ?? "public",
      },
    },
  } as HomeFeedItem
}

const booking = {
  host_user_id: "usr_host",
  base_price_cents: 3500,
  has_available_slot: true,
  starting_price_cents: 2500,
  currency: "USDC" as const,
}

describe("home feed booking discovery", () => {
  test("attaches raw USDC booking metadata for a discoverable host", async () => {
    const item = feedItem()
    const result = await decorateHomeFeedItemsWithBookings({
      items: [item],
      lookup: async () => new Map([["usr_host", booking]]),
    })

    expect(result[0]?.booking).toEqual(booking)
  })

  test("omits booking when no published booking profile is returned", async () => {
    const item = feedItem()
    const result = await decorateHomeFeedItemsWithBookings({
      items: [item],
      lookup: async () => new Map(),
    })

    expect(result[0]).toBe(item)
    expect(result[0]?.booking).toBeUndefined()
  })

  test("omits booking and skips lookup for community-authored items", async () => {
    let calls = 0
    const item = feedItem({ authorUser: null })
    const result = await decorateHomeFeedItemsWithBookings({
      items: [item],
      lookup: async () => {
        calls += 1
        return new Map()
      },
    })

    expect(calls).toBe(0)
    expect(result[0]).toBe(item)
  })

  test("does not leak booking through anonymous identity", async () => {
    let calls = 0
    const item = feedItem({ identityMode: "anonymous" })
    const result = await decorateHomeFeedItemsWithBookings({
      items: [item],
      lookup: async () => {
        calls += 1
        return new Map([["usr_host", booking]])
      },
    })

    expect(calls).toBe(0)
    expect(result[0]?.booking).toBeUndefined()
  })

  test("does not attach the owner booking profile to an agent-authored item", async () => {
    let calls = 0
    const item = feedItem({ authorshipMode: "user_agent" })
    const result = await decorateHomeFeedItemsWithBookings({
      items: [item],
      lookup: async () => {
        calls += 1
        return new Map([["usr_host", booking]])
      },
    })

    expect(calls).toBe(0)
    expect(result[0]?.booking).toBeUndefined()
  })

  test("fails closed without taking down the feed", async () => {
    const item = feedItem()
    const result = await decorateHomeFeedItemsWithBookings({
      items: [item],
      lookup: async () => {
        throw new Error("booking database unavailable")
      },
    })

    expect(result).toEqual([item])
  })

  test("leaves the feed unchanged when booking discovery exceeds its budget", async () => {
    const item = feedItem()
    const result = await decorateHomeFeedItemsWithBookings({
      items: [item],
      lookup: () => new Promise(() => {}),
      lookupTimeoutMs: 1,
    })

    expect(result).toEqual([item])
  })

  test("absorbs a lookup rejection that arrives after the timeout", async () => {
    const item = feedItem()
    const result = await decorateHomeFeedItemsWithBookings({
      items: [item],
      lookup: () =>
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error("late failure")), 10)
        }),
      lookupTimeoutMs: 1,
    })

    expect(result).toEqual([item])
    await new Promise((resolve) => setTimeout(resolve, 20))
  })

  test("deduplicates repeated authors into one batch lookup", async () => {
    const lookups: string[][] = []
    const result = await decorateHomeFeedItemsWithBookings({
      items: [
        feedItem({ id: "post_one" }),
        feedItem({ id: "post_two" }),
        feedItem({ authorUser: "usr_second", id: "post_three" }),
      ],
      lookup: async (hostUserIds) => {
        lookups.push(hostUserIds)
        return new Map([["usr_host", booking]])
      },
    })

    expect(lookups).toEqual([["usr_host", "usr_second"]])
    expect(result.filter((item) => item.booking).map((item) => item.post.post.id)).toEqual(["post_one", "post_two"])
  })

  test("queries published configured hosts once with unique ids", async () => {
    const statements: unknown[] = []
    const executor: FeedBookingExecutor = {
      execute: async (statement) => {
        statements.push(statement)
        return {
          rows: [{
            host_user_id: "usr_host",
            base_price_cents: 3500,
            has_available_slot: true,
            starting_price_cents: 2500,
          }],
        }
      },
    }

    const result = await listFeedBookingsByHostUserIds(executor, ["usr_host", "usr_host", "usr_second"])

    expect(statements).toHaveLength(1)
    expect(statements[0]).toMatchObject({
      args: ["usr_host", "usr_second"],
    })
    expect(String((statements[0] as { sql: string }).sql)).toContain("p.is_published = TRUE")
    expect(String((statements[0] as { sql: string }).sql)).toContain("bookings.feed_discovery_snapshots")
    expect(String((statements[0] as { sql: string }).sql)).toContain("snapshot.valid_until > NOW()")
    expect(result.get("usr_host")).toEqual(booking)
  })

  test("returns a published host with a current empty-window snapshot", async () => {
    const executor: FeedBookingExecutor = {
      execute: async () => ({
        rows: [{
          host_user_id: "usr_host",
          base_price_cents: 3500,
          has_available_slot: false,
          starting_price_cents: null,
        }],
      }),
    }

    const result = await listFeedBookingsByHostUserIds(executor, ["usr_host"])

    expect(result.get("usr_host")).toEqual({
      host_user_id: "usr_host",
      base_price_cents: 3500,
      has_available_slot: false,
      starting_price_cents: null,
      currency: "USDC",
    })
  })
})
