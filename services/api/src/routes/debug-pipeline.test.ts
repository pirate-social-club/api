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
    ])).toEqual(["alpha", "beta"])
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
    }, { ENVIRONMENT: "production" } as Env)
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

  test("accepts real community IDs whose raw segment embeds a legacy prefix", () => {
    expect(parseHomeFeedBenchmarkCommunityIds([
      "com_cmt_b3ede813fccf489982e93739ef1bf6b0",
    ])).toEqual(["cmt_b3ede813fccf489982e93739ef1bf6b0"])
    expect(parseHomeFeedBenchmarkCommunityIds(["com_cmt_b3ede813!"])).toBeNull()
  })
})
