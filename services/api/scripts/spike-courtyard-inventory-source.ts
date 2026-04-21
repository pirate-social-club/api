type Candidate = {
  chunk: string
  matches: string[]
}

type CourtyardConfig = {
  courtyardApiUrl?: string
  supportedChainId?: number
  supportedChainName?: string
}

type CourtyardAsset = {
  attributes?: Array<{ name?: string; value?: string }>
  chain?: string
  collection?: string
  contract?: string
  owner?: { address?: string; user_id?: string; username?: string }
  title?: string
  token_id?: string
  vaulted?: boolean
}

const DEFAULT_ORIGIN = "https://courtyard.io"
const COURTYARD_MAINNET_REGISTRY = "0xd4ac3CE8e1E14CD60666D49AC34Ff2d2937cF6FA"
const ENDPOINT_HINT_PATTERN =
  /https?:\/\/[^"'`\s)]+|[a-z0-9._-]+\.courtyard\.[a-z]+|\/(?:api|graphql|assets?|inventory|tokens?)[^"'`\s)]*/giu
const REQUIRED_FACT_KEYS = ["tokenId", "assetClass", "ownerAddress", "contractAddress"] as const

function readArg(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1] ?? null
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 Pirate inventory source spike" },
  })
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}`)
  }
  return response.text()
}

async function fetchJson<T>(url: string): Promise<T> {
  const text = await fetchText(url)
  return JSON.parse(text) as T
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function extractChunkPaths(html: string): string[] {
  return unique([...html.matchAll(/\/_next\/static\/chunks\/[^"'\\\s]+/gu)].map((match) => match[0]))
}

function extractEndpointHints(source: string): string[] {
  return unique([...source.matchAll(ENDPOINT_HINT_PATTERN)].map((match) => match[0]))
    .filter((value) => !value.includes("_next/static"))
    .filter((value) => /api|graphql|asset|inventory|token|courtyard/iu.test(value))
    .slice(0, 40)
}

async function discoverCandidates(origin: string): Promise<Candidate[]> {
  const html = await fetchText(origin)
  const chunks = extractChunkPaths(html).slice(0, 80)
  const candidates: Candidate[] = []

  for (const chunk of chunks) {
    const source = await fetchText(new URL(chunk, origin).toString()).catch(() => "")
    const matches = extractEndpointHints(source)
    if (matches.length > 0) {
      candidates.push({ chunk, matches })
    }
  }

  return candidates
}

function normalizeAttributeKey(value: string): string {
  return value.trim().normalize("NFC").toLowerCase()
}

function readAttributes(asset: CourtyardAsset): Record<string, string> {
  const values: Record<string, string> = {}
  for (const attr of asset.attributes ?? []) {
    const name = typeof attr.name === "string" ? normalizeAttributeKey(attr.name) : ""
    const value = typeof attr.value === "string" ? attr.value.trim().normalize("NFC") : ""
    if (name && value) values[name] = value
  }
  return values
}

function normalizeAssetFacts(asset: CourtyardAsset): Record<string, unknown> | null {
  const attributes = readAttributes(asset)
  const collection = asset.collection ?? ""
  const category = attributes.category ?? null
  const title = asset.title ?? ""
  const assetClass = /card|booster/iu.test(collection) || attributes.grader || attributes.grade
    ? "trading_card"
    : /watch/iu.test(collection) || /watch/iu.test(title)
      ? "watch"
      : "unknown"
  const subject = attributes["title/subject"] ?? attributes["title/pkmn"] ?? null

  if (!asset.token_id || !asset.owner?.address || !asset.contract) {
    return null
  }

  return {
    tokenId: asset.token_id,
    assetClass,
    category,
    franchise: assetClass === "trading_card" ? category : null,
    subject,
    brand: attributes.brand ?? null,
    model: attributes.model ?? null,
    ownerAddress: asset.owner.address,
    contractAddress: asset.contract,
    chain: asset.chain ?? null,
    vaulted: asset.vaulted ?? null,
  }
}

function hasRequiredFacts(value: unknown): boolean {
  const tokens = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { tokens?: unknown }).tokens)
      ? (value as { tokens: unknown[] }).tokens
      : []
  return tokens.some((token) => (
    token
    && typeof token === "object"
    && REQUIRED_FACT_KEYS.every((key) => key in token)
  ))
}

async function fetchCourtyardConfig(origin: string): Promise<CourtyardConfig> {
  return fetchJson<CourtyardConfig>(new URL("/api/config", origin).toString())
}

async function probeCourtyardOwnership(origin: string, wallet: string, limit: number): Promise<void> {
  const config = await fetchCourtyardConfig(origin)
  if (!config.courtyardApiUrl) {
    throw new Error(`${origin}/api/config did not include courtyardApiUrl`)
  }

  const url = new URL("/index/ownership", config.courtyardApiUrl)
  url.searchParams.set("owner", wallet)
  url.searchParams.set("walletType", "both")
  url.searchParams.set("offset", "0")
  url.searchParams.set("limit", String(limit))

  const response = await fetchJson<{ assets?: CourtyardAsset[]; total?: number }>(url.toString())
  const facts = (response.assets ?? []).map(normalizeAssetFacts).filter((value): value is Record<string, unknown> => Boolean(value))

  console.log(JSON.stringify({
    verified: hasRequiredFacts(facts),
    source: "courtyard_index_ownership",
    origin,
    courtyardApiUrl: config.courtyardApiUrl,
    supportedChainId: config.supportedChainId ?? null,
    supportedChainName: config.supportedChainName ?? null,
    requestedWallet: wallet,
    total: response.total ?? null,
    sampled: facts.length,
    requiredFactKeys: REQUIRED_FACT_KEYS,
    sampleFacts: facts.slice(0, 5),
    auditNotes: [
      "This proves a public owner-to-asset facts path exists.",
      "This does not yet prove API stability, official support, auth/rate-limit terms, or all luxury-watch fields.",
      "The sampled current Courtyard app chain may be Polygon even though older docs mention an Ethereum registry.",
    ],
  }, null, 2))
}

async function probeEndpoint(endpoint: string, wallet: string, tokenId: string | null): Promise<void> {
  const url = new URL(endpoint)
  url.searchParams.set("wallet", wallet)
  url.searchParams.set("contract_address", COURTYARD_MAINNET_REGISTRY)
  if (tokenId) url.searchParams.set("token_id", tokenId)

  const response = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0 Pirate inventory source spike" },
  })
  const body = await response.text()
  const parsed = body ? JSON.parse(body) as unknown : null

  console.log(JSON.stringify({
    endpoint: url.toString(),
    status: response.status,
    verified: response.ok && hasRequiredFacts(parsed),
    requiredFactKeys: REQUIRED_FACT_KEYS,
    sample: parsed,
  }, null, 2))
}

async function main(): Promise<void> {
  const origin = readArg("--origin") ?? DEFAULT_ORIGIN
  const endpoint = readArg("--endpoint")
  const wallet = readArg("--wallet")
  const tokenId = readArg("--token-id")
  const limit = Number.parseInt(readArg("--limit") ?? "5", 10)

  if (endpoint) {
    if (!wallet) {
      throw new Error("--wallet is required when --endpoint is provided")
    }
    await probeEndpoint(endpoint, wallet, tokenId)
    return
  }
  if (wallet) {
    await probeCourtyardOwnership(origin, wallet, Number.isInteger(limit) && limit > 0 ? Math.min(limit, 50) : 5)
    return
  }

  const config = await fetchCourtyardConfig(origin).catch(() => null)
  const candidates = await discoverCandidates(origin)
  console.log(JSON.stringify({
    verified: false,
    reason: "No authoritative Courtyard owner-inventory endpoint was provided or verified.",
    origin,
    registryContract: COURTYARD_MAINNET_REGISTRY,
    courtyardApiUrl: config?.courtyardApiUrl ?? null,
    supportedChainId: config?.supportedChainId ?? null,
    supportedChainName: config?.supportedChainName ?? null,
    candidateHints: candidates,
    nextStep: "Run again with --wallet <known owner> to probe /index/ownership, then verify API stability/support with Courtyard before enforcement.",
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
