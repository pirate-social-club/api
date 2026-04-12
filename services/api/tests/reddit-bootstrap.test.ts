import { afterEach, describe, expect, test } from "bun:test"
import { buildTestEnv } from "./helpers"
import { importRedditSnapshot, setRedditSnapshotImporterForTests } from "../src/lib/onboarding/reddit-bootstrap"

const originalFetch = globalThis.fetch
const originalDateNow = Date.now

afterEach(() => {
  globalThis.fetch = originalFetch
  Date.now = originalDateNow
  setRedditSnapshotImporterForTests(null)
})

describe("reddit bootstrap importer", () => {
  test("default importer derives top subreddits, moderator_of, and inferred interests", async () => {
    const env = buildTestEnv()
    const fixedNow = Date.parse("2026-04-10T12:00:00.000Z")
    Date.now = () => fixedNow

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("/search/submission/")) {
        return new Response(JSON.stringify({
          data: [
            { subreddit: "hiphopheads", score: 100, created_utc: 1_743_508_800 },
            { subreddit: "makinghiphop", score: 50, created_utc: 1_743_595_200 },
          ],
        }), { status: 200 })
      }
      if (url.includes("/search/comment/")) {
        return new Response(JSON.stringify({
          data: [
            { subreddit: "hiphopheads", score: 25, created_utc: 1_743_681_600, distinguished: "moderator" },
            { subreddit: "makinghiphop", score: 10, created_utc: 1_743_768_000 },
          ],
        }), { status: 200 })
      }
      return new Response("not found", { status: 404 })
    }) as typeof globalThis.fetch

    const summary = await importRedditSnapshot({
      env,
      redditUsername: "technohippie",
    })

    expect(summary.reddit_username).toBe("technohippie")
    expect(summary.global_karma).toBe(185)
    expect(Boolean(summary.account_age_days != null && summary.account_age_days > 0)).toBe(true)
    expect(summary.top_subreddits).toEqual([
      {
        subreddit: "hiphopheads",
        karma: 125,
        posts: 2,
        rank_source: "karma",
      },
      {
        subreddit: "makinghiphop",
        karma: 60,
        posts: 2,
        rank_source: "karma",
      },
    ])
    expect(summary.moderator_of).toEqual(["hiphopheads"])
    expect(summary.inferred_interests).toEqual(["hiphopheads", "makinghiphop"])
    expect(summary.suggested_communities).toEqual([])
    expect(summary.coverage_note).toMatch(/Historical archival snapshot/)
  })

  test("default importer keeps partial data when one PullPush source fails", async () => {
    const env = buildTestEnv()

    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      if (url.includes("/search/submission/")) {
        return new Response(JSON.stringify({
          data: [
            { subreddit: "indieheads", score: 30, created_utc: 1_743_508_800 },
          ],
        }), { status: 200 })
      }
      if (url.includes("/search/comment/")) {
        return new Response("upstream failure", { status: 500 })
      }
      return new Response("not found", { status: 404 })
    }) as typeof globalThis.fetch

    const summary = await importRedditSnapshot({
      env,
      redditUsername: "partialuser",
    })

    expect(summary.global_karma).toBe(30)
    expect(summary.top_subreddits).toEqual([
      {
        subreddit: "indieheads",
        karma: 30,
        posts: 1,
        rank_source: "karma",
      },
    ])
    expect(summary.coverage_note).toMatch(/Partial historical archival snapshot/)
    expect(summary.coverage_note).toMatch(/comment fetch failed with source_error/)
  })

  test("default importer fails with rate_limited when both PullPush sources rate limit", async () => {
    const env = buildTestEnv()

    globalThis.fetch = (async () => {
      return new Response("slow down", { status: 429 })
    }) as typeof globalThis.fetch

    try {
      await importRedditSnapshot({
        env,
        redditUsername: "rate-limited-user",
      })
      expect("no error").toBe("rate_limited")
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).toBe("rate_limited")
    }
  })
})
