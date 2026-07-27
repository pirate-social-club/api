import { describe, expect, test } from "bun:test"
import type { Env } from "../env"
import { parseHomeFeedBenchmarkCommunityIds } from "./debug-home-feed-benchmark"
import debugPipeline from "./debug-pipeline"

describe("parseHomeFeedBenchmarkCommunityIds", () => {
  test("normalizes and deduplicates a bounded fixture scope", () => {
    expect(parseHomeFeedBenchmarkCommunityIds([
      " com_alpha ",
      "com_beta",
      "com_alpha",
    ])).toEqual(["com_alpha", "com_beta"])
  })

  test("fails closed for missing, malformed, empty, or oversized scopes", () => {
    expect(parseHomeFeedBenchmarkCommunityIds(null)).toBeNull()
    expect(parseHomeFeedBenchmarkCommunityIds([])).toBeNull()
    expect(parseHomeFeedBenchmarkCommunityIds(["not-public-id"])).toBeNull()
    expect(parseHomeFeedBenchmarkCommunityIds(
      Array.from({ length: 17 }, (_, index) => `com_${index}`),
    )).toBeNull()
  })
})

describe("home-feed benchmark route guards", () => {
  test("requires an operator token", async () => {
    const response = await debugPipeline.request("/home-feed-benchmark", {
      method: "POST",
    }, { ENVIRONMENT: "staging", PIRATE_ADMIN_TOKEN: "secret" } as Env)
    expect(response.status).toBe(401)
  })

  test("is absent outside staging", async () => {
    const response = await debugPipeline.request("/home-feed-benchmark", {
      method: "POST",
      headers: { "x-admin-token": "secret" },
    }, { ENVIRONMENT: "production", PIRATE_ADMIN_TOKEN: "secret" } as Env)
    expect(response.status).toBe(404)
  })

  test("rejects an invalid candidate scope before opening feed storage", async () => {
    const response = await debugPipeline.request("/home-feed-benchmark", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-token": "secret",
      },
      body: JSON.stringify({
        community_ids: [],
        user_id: "usr_benchmark",
      }),
    }, { ENVIRONMENT: "staging", PIRATE_ADMIN_TOKEN: "secret" } as Env)
    expect(response.status).toBe(400)
  })
})
