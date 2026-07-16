import type { NftGateCapabilitySource, NftGateFacetValuePage } from "@pirate/api-contracts"
import type { Env } from "../../../env"
import { COURTYARD_REGISTRIES } from "../courtyard-registry-config"

type SourceDefinition = {
  descriptor: NftGateCapabilitySource
  upstreamCollection: "Graded Cards" | "Watches"
  upstreamFacets: Record<string, string>
}

type PublicSearchConfig = {
  appId: string
  apiKey: string
  indexName: string
  expiresAtMs: number
  staleAtMs: number
}

type CachedPage = {
  page: NftGateFacetValuePage
  expiresAtMs: number
  staleAtMs: number
}

type AlgoliaFacetHit = { value?: unknown; count?: unknown }

export class CourtyardCatalogUnavailableError extends Error {}

const COURTYARD_WEB_URL = "https://www.courtyard.io"
const ALGOLIA_APP_ID = "Y8TL3M06QA"
const ALGOLIA_INDEX_NAME = "marketplace_prod_asset_ownership"
const FETCH_TIMEOUT_MS = 8_000
const CONFIG_TTL_MS = 60 * 60_000
const PAGE_TTL_MS = 5 * 60_000
const STALE_TTL_MS = 24 * 60 * 60_000
const MAX_ALGOLIA_FACET_HITS = 100
const USER_AGENT = "Pirate NFT gate catalog"

const COLLECTIONS = [
  {
    slug: "graded-cards",
    label: "Courtyard graded cards",
    upstreamCollection: "Graded Cards" as const,
    category: "trading_card",
    upstreamFacets: {
      franchise: "Category",
      subject: "Title/Subject",
      set: "Set",
      year: "Year",
      grader: "Grader",
      grade: "Grade",
    },
  },
  {
    slug: "watches",
    label: "Courtyard watches",
    upstreamCollection: "Watches" as const,
    category: "watch",
    upstreamFacets: {
      brand: "Brand",
      reference: "Reference",
      year: "Year",
      condition: "Condition",
    },
  },
] as const

const SOURCE_DEFINITIONS: SourceDefinition[] = COURTYARD_REGISTRIES.flatMap((registry) => COLLECTIONS.map((collection) => {
  const chainSlug = registry.chainNamespace === "eip155:1" ? "ethereum" : "polygon"
  const facetKeys = Object.keys(collection.upstreamFacets)
  return {
    descriptor: {
      id: `courtyard-${collection.slug}-${chainSlug}`,
      label: `${collection.label} on ${chainSlug === "ethereum" ? "Ethereum" : "Polygon"}`,
      chain_namespace: registry.chainNamespace,
      contract_address: registry.contractAddress,
      standard: "erc721",
      trait_filters_supported: true,
      facet_keys: facetKeys,
      facet_labels: Object.fromEntries(facetKeys.map((key) => [key, key.replace(/(^|_)([a-z])/gu, (_match, _prefix, letter: string) => ` ${letter.toUpperCase()}`).trim()])),
      max_values_per_facet: 10,
      inventory_provider: "courtyard",
      fixed_match: { category: collection.category },
      min_quantity_supported: true,
    },
    upstreamCollection: collection.upstreamCollection,
    upstreamFacets: collection.upstreamFacets,
  }
}))

let cachedSearchConfig: PublicSearchConfig | null = null
let inFlightSearchConfig: Promise<PublicSearchConfig> | null = null
const pageCache = new Map<string, CachedPage>()
const inFlightPages = new Map<string, Promise<NftGateFacetValuePage>>()

export function resetCourtyardCatalogCacheForTests(): void {
  cachedSearchConfig = null
  inFlightSearchConfig = null
  pageCache.clear()
  inFlightPages.clear()
}

export function listNftGateCapabilitySources(): NftGateCapabilitySource[] {
  return SOURCE_DEFINITIONS.map(({ descriptor }) => ({
    ...descriptor,
    facet_keys: [...descriptor.facet_keys],
    facet_labels: { ...descriptor.facet_labels },
    fixed_match: { ...descriptor.fixed_match },
  }))
}

export function getNftGateCapabilitySource(sourceId: string): SourceDefinition | null {
  return SOURCE_DEFINITIONS.find(({ descriptor }) => descriptor.id === sourceId) ?? null
}

async function fetchWithTimeout(fetchImpl: typeof fetch, input: string | URL, init?: RequestInit): Promise<Response> {
  const abortController = new AbortController()
  const timeoutId = setTimeout(() => abortController.abort(new Error("Courtyard catalog lookup timed out")), FETCH_TIMEOUT_MS)
  try {
    return await fetchImpl(input, { ...init, signal: abortController.signal })
  } finally {
    clearTimeout(timeoutId)
  }
}

async function fetchSearchConfig(fetchImpl: typeof fetch, nowMs: number): Promise<PublicSearchConfig> {
  const response = await fetchWithTimeout(fetchImpl, `${COURTYARD_WEB_URL}/api/config`, {
    headers: { "user-agent": USER_AGENT },
  })
  if (!response.ok) throw new CourtyardCatalogUnavailableError(`Courtyard search configuration failed with ${response.status}`)
  const body = await response.json() as { environment?: unknown; algoliaApiKey?: unknown }
  const apiKey = typeof body.algoliaApiKey === "string" ? body.algoliaApiKey.trim() : ""
  if (body.environment !== "prod" || !/^[a-z0-9]{16,128}$/iu.test(apiKey)) {
    throw new CourtyardCatalogUnavailableError("Courtyard search configuration is invalid")
  }
  return {
    appId: ALGOLIA_APP_ID,
    apiKey,
    indexName: ALGOLIA_INDEX_NAME,
    expiresAtMs: nowMs + CONFIG_TTL_MS,
    staleAtMs: nowMs + STALE_TTL_MS,
  }
}

async function getSearchConfig(fetchImpl: typeof fetch, nowMs: number): Promise<PublicSearchConfig> {
  if (cachedSearchConfig && cachedSearchConfig.expiresAtMs > nowMs) return cachedSearchConfig
  if (!inFlightSearchConfig) {
    inFlightSearchConfig = fetchSearchConfig(fetchImpl, nowMs).then((config) => {
      cachedSearchConfig = config
      return config
    }).finally(() => { inFlightSearchConfig = null })
  }
  try {
    return await inFlightSearchConfig
  } catch (error) {
    if (cachedSearchConfig && cachedSearchConfig.staleAtMs > nowMs) return cachedSearchConfig
    if (error instanceof CourtyardCatalogUnavailableError) throw error
    throw new CourtyardCatalogUnavailableError("Courtyard search configuration is unavailable")
  }
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0
  const match = /^v1:(\d{1,3})$/u.exec(cursor)
  if (!match) throw new TypeError("Invalid cursor")
  const offset = Number(match[1])
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= MAX_ALGOLIA_FACET_HITS) throw new TypeError("Invalid cursor")
  return offset
}

function normalizeFacetHits(value: unknown): Array<{ value: string; approximate_count?: number }> {
  if (!Array.isArray(value)) throw new CourtyardCatalogUnavailableError("Courtyard search returned an invalid response")
  const seen = new Set<string>()
  const values: Array<{ value: string; approximate_count?: number }> = []
  for (const rawHit of value as AlgoliaFacetHit[]) {
    const facetValue = typeof rawHit?.value === "string" ? rawHit.value.trim() : ""
    if (!facetValue || facetValue.length > 200 || seen.has(facetValue)) continue
    seen.add(facetValue)
    const count = typeof rawHit.count === "number" && Number.isSafeInteger(rawHit.count) && rawHit.count >= 0
      ? rawHit.count
      : null
    values.push({ value: facetValue, ...(count != null ? { approximate_count: count } : {}) })
  }
  return values
}

async function fetchFacetPage(input: {
  source: SourceDefinition
  facetKey: string
  query: string
  offset: number
  limit: number
  fetchImpl: typeof fetch
  nowMs: number
}): Promise<NftGateFacetValuePage> {
  const config = await getSearchConfig(input.fetchImpl, input.nowMs)
  const maxFacetHits = Math.min(input.offset + input.limit, MAX_ALGOLIA_FACET_HITS)
  if (input.offset >= maxFacetHits) throw new TypeError("Invalid cursor")
  const upstreamFacet = input.source.upstreamFacets[input.facetKey]
  if (!upstreamFacet) throw new TypeError("Invalid facet")
  const url = new URL(`/1/indexes/${encodeURIComponent(config.indexName)}/facets/${encodeURIComponent(`metadata.${upstreamFacet}`)}/query`, `https://${config.appId}-dsn.algolia.net`)
  const response = await fetchWithTimeout(input.fetchImpl, url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": USER_AGENT,
      "x-algolia-application-id": config.appId,
      "x-algolia-api-key": config.apiKey,
    },
    body: JSON.stringify({
      facetQuery: input.query,
      maxFacetHits,
      filters: `collection:${JSON.stringify(input.source.upstreamCollection)}`,
    }),
  })
  if (!response.ok) throw new CourtyardCatalogUnavailableError(`Courtyard facet search failed with ${response.status}`)
  const body = await response.json() as { facetHits?: unknown }
  const allValues = normalizeFacetHits(body.facetHits)
  const values = allValues.slice(input.offset, input.offset + input.limit)
  const nextOffset = input.offset + values.length
  return {
    values,
    next_cursor: allValues.length === maxFacetHits && nextOffset < MAX_ALGOLIA_FACET_HITS ? `v1:${nextOffset}` : null,
    catalog_fetched_at: new Date(input.nowMs).toISOString(),
  }
}

export async function searchNftGateFacetValues(input: {
  env: Env
  source: SourceDefinition
  facetKey: string
  query: string
  cursor?: string
  limit: number
  fetchImpl?: typeof fetch
  nowMs?: number
}): Promise<NftGateFacetValuePage> {
  void input.env
  const offset = decodeCursor(input.cursor)
  const nowMs = input.nowMs ?? Date.now()
  const cacheKey = JSON.stringify([input.source.upstreamCollection, input.facetKey, input.query, offset, input.limit])
  const cached = pageCache.get(cacheKey)
  if (cached && cached.expiresAtMs > nowMs) return cached.page

  let pending = inFlightPages.get(cacheKey)
  if (!pending) {
    pending = fetchFacetPage({
      source: input.source,
      facetKey: input.facetKey,
      query: input.query,
      offset,
      limit: input.limit,
      fetchImpl: input.fetchImpl ?? fetch,
      nowMs,
    }).then((page) => {
      pageCache.set(cacheKey, { page, expiresAtMs: nowMs + PAGE_TTL_MS, staleAtMs: nowMs + STALE_TTL_MS })
      return page
    }).finally(() => inFlightPages.delete(cacheKey))
    inFlightPages.set(cacheKey, pending)
  }
  try {
    return await pending
  } catch (error) {
    if (cached && cached.staleAtMs > nowMs) return cached.page
    if (error instanceof TypeError || error instanceof CourtyardCatalogUnavailableError) throw error
    throw new CourtyardCatalogUnavailableError("Courtyard facet search is unavailable")
  }
}
