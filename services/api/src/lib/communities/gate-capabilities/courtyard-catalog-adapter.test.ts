import { afterEach, describe, expect, test } from "bun:test"
import type { Env } from "../../../env"
import {
  CourtyardCatalogUnavailableError,
  getNftGateCapabilitySource,
  listNftGateCapabilitySources,
  resetCourtyardCatalogCacheForTests,
  searchNftGateFacetValues,
} from "./courtyard-catalog-adapter"

afterEach(() => resetCourtyardCatalogCacheForTests())

const env = {} as Env

function cardsSource() {
  const source = getNftGateCapabilitySource("courtyard-graded-cards-ethereum")
  if (!source) throw new Error("missing test source")
  return source
}

describe("Courtyard NFT gate catalog adapter", () => {
  test("derives stable source descriptors from the allowlisted registries", () => {
    const sources = listNftGateCapabilitySources()
    expect(sources).toHaveLength(4)
    expect(sources[0]).toMatchObject({
      id: "courtyard-graded-cards-ethereum",
      chain_namespace: "eip155:1",
      inventory_provider: "courtyard",
      fixed_match: { category: "trading_card" },
      facet_keys: ["franchise", "subject", "set", "year", "grader", "grade"],
    })
    expect(sources[2]?.chain_namespace).toBe("eip155:137")
  })

  test("normalizes, searches, paginates, and caches vendor facet values", async () => {
    let calls = 0
    const fetchImpl: typeof fetch = async (request, init) => {
      calls += 1
      if (String(request).endsWith("/api/config")) {
        return Response.json({ environment: "prod", algoliaApiKey: "aaaaaaaaaaaaaaaa" })
      }
      const maxFacetHits = JSON.parse(String(init?.body)) as { maxFacetHits: number }
      return Response.json({ facetHits: [
        { value: "charizard", count: 12 },
        { value: "Charizard VMAX", count: 7 },
        { value: "Charmeleon", count: 3 },
      ].slice(0, maxFacetHits.maxFacetHits) })
    }

    const first = await searchNftGateFacetValues({
      env,
      source: cardsSource(),
      facetKey: "subject",
      query: "char",
      limit: 2,
      fetchImpl,
      nowMs: 1_700_000_000_000,
    })
    expect(first).toEqual({
      values: [{ value: "charizard", approximate_count: 12 }, { value: "Charizard VMAX", approximate_count: 7 }],
      next_cursor: "v1:2",
      catalog_fetched_at: "2023-11-14T22:13:20.000Z",
    })

    const second = await searchNftGateFacetValues({
      env,
      source: cardsSource(),
      facetKey: "subject",
      query: "char",
      cursor: first.next_cursor ?? undefined,
      limit: 2,
      fetchImpl,
      nowMs: 1_700_000_001_000,
    })
    expect(second.values).toEqual([{ value: "Charmeleon", approximate_count: 3 }])
    expect(second.next_cursor).toBeNull()
    expect(calls).toBe(3)
  })

  test("uses last-known-good data when refresh fails", async () => {
    let available = true
    const fetchImpl: typeof fetch = async (request) => {
      if (String(request).endsWith("/api/config")) {
        return Response.json({ environment: "prod", algoliaApiKey: "aaaaaaaaaaaaaaaa" })
      }
      if (!available) throw new Error("offline")
      return Response.json({ facetHits: [{ value: "Charizard", count: 1 }] })
    }
    const initial = await searchNftGateFacetValues({ env, source: cardsSource(), facetKey: "subject", query: "", limit: 25, fetchImpl, nowMs: 0 })
    available = false
    const stale = await searchNftGateFacetValues({ env, source: cardsSource(), facetKey: "subject", query: "", limit: 25, fetchImpl, nowMs: 6 * 60_000 })
    expect(stale).toEqual(initial)
  })

  test("fails explicitly when neither current nor stale catalog data exists", async () => {
    const fetchImpl: typeof fetch = async () => new Response("unavailable", { status: 503 })
    await expect(searchNftGateFacetValues({
      env,
      source: cardsSource(),
      facetKey: "subject",
      query: "",
      limit: 25,
      fetchImpl,
      nowMs: 0,
    })).rejects.toBeInstanceOf(CourtyardCatalogUnavailableError)
  })

  test("rejects malformed cursors before calling the provider", async () => {
    let called = false
    const fetchImpl: typeof fetch = async () => {
      called = true
      return Response.json({})
    }
    await expect(searchNftGateFacetValues({
      env,
      source: cardsSource(),
      facetKey: "subject",
      query: "",
      cursor: "not-a-cursor",
      limit: 25,
      fetchImpl,
    })).rejects.toThrow("Invalid cursor")
    expect(called).toBe(false)
  })
})
