import { describe, expect, test } from "bun:test"
import type { Env, PublicReadCacheRpc } from "../env"
import publicReadCacheCanary from "../routes/public-read-cache-canary"
import {
  PUBLIC_READ_CACHE_CANARY_HEADER,
  PUBLIC_READ_CACHE_CANARY_TAG,
  runPublicReadCacheCanary,
  shouldRunPublicReadCacheCanary,
} from "./public-read-cache-canary"

function fakeEntrypoint(options?: { evict?: boolean; cache?: boolean; staleReadsAfterPurge?: number }): PublicReadCacheRpc {
  const responses = new Map<string, string>()
  let purgeCalled = false
  let staleReadsRemaining = options?.staleReadsAfterPurge ?? 0
  return {
    async fetch(request) {
      const key = request.url
      const current = request.headers.get(PUBLIC_READ_CACHE_CANARY_HEADER) ?? "missing"
      const cached = responses.get(key)
      if (cached !== undefined && options?.cache !== false) {
        if (purgeCalled && options?.evict !== false && staleReadsRemaining <= 0) {
          responses.delete(key)
          responses.set(key, current)
          return Response.json({ value: current })
        }
        if (purgeCalled) staleReadsRemaining -= 1
        return Response.json({ value: cached })
      }
      responses.set(key, current)
      return Response.json({ value: current })
    },
    async purgeCacheTags(tags) {
      expect(tags).toEqual([PUBLIC_READ_CACHE_CANARY_TAG])
      purgeCalled = true
      if (options?.evict !== false && staleReadsRemaining <= 0) responses.clear()
      return { success: true }
    },
  }
}

describe("public read cache canary", () => {
  test("proves a warmed entry changes after the purge", async () => {
    await expect(runPublicReadCacheCanary({
      PUBLIC_READ_CACHE: fakeEntrypoint(),
    } as Env, { now: () => 1_000 })).resolves.toEqual({ warmed: true, evicted: true, propagation_ms: 0 })
  })

  test("allows bounded cache purge propagation delay", async () => {
    let now = 1_000
    await expect(runPublicReadCacheCanary({
      PUBLIC_READ_CACHE: fakeEntrypoint({ staleReadsAfterPurge: 2 }),
    } as Env, {
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds
      },
    })).resolves.toEqual({ warmed: true, evicted: true, propagation_ms: 500 })
  })

  test("fails when purge reports success without evicting", async () => {
    await expect(runPublicReadCacheCanary({
      PUBLIC_READ_CACHE: fakeEntrypoint({ evict: false }),
    } as Env, { sleep: async () => {} })).rejects.toThrow("reported success but did not evict")
  })

  test("fails when the entrypoint is not caching responses", async () => {
    await expect(runPublicReadCacheCanary({
      PUBLIC_READ_CACHE: fakeEntrypoint({ cache: false }),
    } as Env)).rejects.toThrow("could not observe a warmed cache entry")
  })

  test("runs only on configured intervals with the cache binding present", () => {
    const env = {
      PUBLIC_READ_CACHE: fakeEntrypoint(),
      PUBLIC_READ_CACHE_CANARY_ENABLED: "true",
      PUBLIC_READ_CACHE_CANARY_INTERVAL_MINUTES: "15",
    } as Env
    expect(shouldRunPublicReadCacheCanary(env, Date.UTC(2026, 6, 22, 10, 30))).toBe(true)
    expect(shouldRunPublicReadCacheCanary(env, Date.UTC(2026, 6, 22, 10, 31))).toBe(false)
    expect(shouldRunPublicReadCacheCanary({ ...env, PUBLIC_READ_CACHE: undefined }, Date.UTC(2026, 6, 22, 10, 30))).toBe(false)
    expect(shouldRunPublicReadCacheCanary({ ...env, PUBLIC_READ_CACHE_CANARY_ENABLED: "false" }, Date.UTC(2026, 6, 22, 10, 30))).toBe(false)
  })

  test("route returns the bounded origin value with the canary cache tag", async () => {
    const response = await publicReadCacheCanary.request("http://pirate.test/", {
      headers: { [PUBLIC_READ_CACHE_CANARY_HEADER]: "origin-value" },
    })
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-tag")).toBe(PUBLIC_READ_CACHE_CANARY_TAG)
    expect(response.headers.get("cdn-cache-control")).toContain("max-age=600")
    expect(await response.json()).toEqual({ value: "origin-value" })
  })
})
