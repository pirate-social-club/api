import type { Env } from "../../env"
import type { WalletAttachmentSummary } from "../../types"
import { DEFAULT_COURTYARD_API_URL, COURTYARD_REGISTRIES } from "./courtyard-registry-config"
import { normalizeEthereumAddress } from "./community-token-gates"

export type Erc721InventoryProvider = "courtyard"
export type Erc721InventoryAssetCategory = "trading_card" | "watch"
export type Erc721InventoryAssetMatch = {
  category?: Erc721InventoryAssetCategory
  franchise?: string
  subject?: string
  brand?: string
  model?: string
  reference?: string
  set?: string
  year?: string
  grader?: string
  grade?: string
  condition?: string
}
export type Erc721InventoryAssetFilter = Erc721InventoryAssetMatch

export type Erc721InventoryMatchConfig = {
  chainNamespace: "eip155:1" | "eip155:137"
  contractAddress: string
  inventoryProvider: Erc721InventoryProvider
  minQuantity: number
  assetFilter: Erc721InventoryAssetMatch
}

export type Erc721InventoryAsset = {
  chainNamespace: string
  contractAddress: string
  tokenId: string
  ownerAddress: string
  category: Erc721InventoryAssetCategory | "unknown"
  franchise: string | null
  subject: string | null
  brand: string | null
  model: string | null
  reference: string | null
  set: string | null
  year: string | null
  grader: string | null
  grade: string | null
  condition: string | null
}

type CourtyardAsset = {
  attributes?: RawInventoryAttribute[]
  chain?: string
  collection?: string
  contract?: string
  owner?: { address?: string }
  title?: string
  token_id?: string
}

export type RawInventoryAttribute = {
  name?: string
  trait_type?: string
  traitType?: string
  value?: unknown
}

export type RawInventoryMetadata = {
  attributes?: RawInventoryAttribute[]
  collection?: string
  title?: string
  name?: string
}

type NormalizedInventoryFacts = Omit<
  Erc721InventoryAsset,
  "chainNamespace" | "contractAddress" | "tokenId" | "ownerAddress"
>

type CourtyardInventoryCacheEntry = {
  matchedQuantity: number
  expiresAtMs: number
}

let erc721InventoryMatcherForTests: ((input: {
  env: Env
  walletAddresses: string[]
  config: Erc721InventoryMatchConfig
}) => Promise<{ matchedQuantity: number; unavailable?: boolean }>) | null = null

const courtyardInventoryMatchCache = new Map<string, CourtyardInventoryCacheEntry>()
const DEFAULT_COURTYARD_INVENTORY_CACHE_TTL_MS = 60_000
const MAX_COURTYARD_INVENTORY_CACHE_ENTRIES = 1_000

export function setErc721InventoryMatcherForTests(
  matcher: ((input: {
    env: Env
    walletAddresses: string[]
    config: Erc721InventoryMatchConfig
  }) => Promise<{ matchedQuantity: number; unavailable?: boolean }>) | null,
): void {
  erc721InventoryMatcherForTests = matcher
}

export function clearErc721InventoryMatchCacheForTests(): void {
  courtyardInventoryMatchCache.clear()
}

export function normalizeInventoryText(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().normalize("NFC").normalize("NFD").replace(/\p{Mark}/gu, "").toLowerCase()
  return normalized.length > 0 ? normalized : null
}

function listAttachedWalletAddressesForChain(
  walletAttachments: WalletAttachmentSummary[],
  chainNamespace: Erc721InventoryMatchConfig["chainNamespace"],
): string[] {
  const seen = new Set<string>()
  const addresses: string[] = []

  for (const attachment of walletAttachments) {
    if (attachment.chain_namespace !== chainNamespace) {
      continue
    }
    const normalized = normalizeEthereumAddress(attachment.wallet_address)
    if (!normalized || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    addresses.push(normalized)
  }

  return addresses
}

export function isAllowedCourtyardRegistry(input: {
  chainNamespace: string | null | undefined
  contractAddress: unknown
}): boolean {
  const normalized = normalizeEthereumAddress(input.contractAddress)
  if (!normalized) return false
  return COURTYARD_REGISTRIES.some((registry) =>
    registry.chainNamespace === input.chainNamespace
    && normalizeEthereumAddress(registry.contractAddress) === normalized
  )
}

export function readInventoryMatchConfig(gateConfig: Record<string, unknown> | null, chainNamespace: string | null): Erc721InventoryMatchConfig | null {
  if (!gateConfig || (chainNamespace !== "eip155:1" && chainNamespace !== "eip155:137")) {
    return null
  }

  const contractAddress = normalizeEthereumAddress(gateConfig.contract_address)
  if (!contractAddress || !isAllowedCourtyardRegistry({ chainNamespace, contractAddress })) {
    return null
  }
  if (gateConfig.inventory_provider !== "courtyard") {
    return null
  }
  if (!Number.isInteger(gateConfig.min_quantity) || (gateConfig.min_quantity as number) < 1 || (gateConfig.min_quantity as number) > 100) {
    return null
  }
  const assetFilter = normalizeAssetMatch(gateConfig.match ?? gateConfig.asset_filter)
  if (!assetFilter) {
    return null
  }

  return {
    chainNamespace,
    contractAddress,
    inventoryProvider: "courtyard",
    minQuantity: gateConfig.min_quantity as number,
    assetFilter,
  }
}

const INVENTORY_MATCH_KEYS = [
  "category",
  "franchise",
  "subject",
  "brand",
  "model",
  "reference",
  "set",
  "year",
  "grader",
  "grade",
  "condition",
] as const

export function getInventoryMatchKeys(): readonly string[] {
  return INVENTORY_MATCH_KEYS
}

export function normalizeAssetMatch(value: unknown): Erc721InventoryAssetMatch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }

  const raw = value as Record<string, unknown>
  const allowedKeys = new Set<string>(INVENTORY_MATCH_KEYS)
  if (Object.keys(raw).some((key) => !allowedKeys.has(key))) {
    return null
  }

  const category = normalizeInventoryText(raw.category)
  if (category !== "trading_card" && category !== "watch") {
    return null
  }

  const filter: Erc721InventoryAssetMatch = { category }
  for (const key of INVENTORY_MATCH_KEYS) {
    if (key === "category") continue
    const normalized = normalizeInventoryText(raw[key])
    if (normalized) {
      filter[key] = normalized
    }
  }

  if (Object.keys(filter).length <= 1) {
    return null
  }
  if (category === "trading_card" && !filter.franchise && !filter.subject) {
    return null
  }
  if (category === "watch" && !filter.brand && !filter.model) {
    return null
  }

  return filter
}

export function formatAssetFilterLabel(filter: Erc721InventoryAssetMatch): string {
  const values = INVENTORY_MATCH_KEYS
    .filter((key) => key !== "category")
    .map((key) => filter[key])
    .filter((value): value is string => Boolean(value))
  return values.join(" ")
}

function readRawInventoryAttributes(attributes: RawInventoryAttribute[] | undefined): Record<string, string> {
  const values: Record<string, string> = {}
  for (const attribute of attributes ?? []) {
    const key = normalizeInventoryText(attribute.name ?? attribute.trait_type ?? attribute.traitType)
    const value = normalizeInventoryText(attribute.value)
    if (key && value) values[key] = value
  }
  return values
}

function firstAttribute(attributes: Record<string, string>, keys: string[]): string | null {
  for (const key of keys) {
    const normalizedKey = normalizeInventoryText(key)
    if (normalizedKey && attributes[normalizedKey]) {
      return attributes[normalizedKey]
    }
  }
  return null
}

export function normalizeInventoryMetadata(input: RawInventoryMetadata): NormalizedInventoryFacts {
  const attributes = readRawInventoryAttributes(input.attributes)
  const collection = normalizeInventoryText(input.collection) ?? ""
  const title = normalizeInventoryText(input.title ?? input.name) ?? ""
  const categoryAttribute = firstAttribute(attributes, ["category", "asset category", "type"])
  const subject = firstAttribute(attributes, ["title/subject", "title/pkmn", "subject", "character", "player"])
  const brand = firstAttribute(attributes, ["brand", "manufacturer", "maker"])
  const model = firstAttribute(attributes, ["model"])
  const reference = firstAttribute(attributes, ["reference", "ref", "reference number"])
  const set = firstAttribute(attributes, ["set", "card set"])
  const year = firstAttribute(attributes, ["year"])
  const grader = firstAttribute(attributes, ["grader", "grading company"])
  const grade = firstAttribute(attributes, ["grade"])
  const condition = firstAttribute(attributes, ["condition"])
  const category = collection.includes("watch")
    || title.includes("watch")
    || categoryAttribute === "watches"
    || Boolean(brand && (model || reference))
    ? "watch"
    : collection.includes("card")
      || collection.includes("booster")
      || collection.includes("tcg")
      || Boolean(subject || set || grader || grade)
      ? "trading_card"
      : "unknown"

  return {
    category,
    franchise: category === "trading_card" ? categoryAttribute ?? null : null,
    subject,
    brand,
    model,
    reference,
    set,
    year,
    grader,
    grade,
    condition,
  }
}

// Courtyard eligibility depends on this observed /index/ownership shape:
// chain=polygon, contract, token_id, owner.address, collection/title, and normalized attributes.
// We intentionally treat franchise/brand as exact facets and subject/model as contains filters
// so broad UI values like "Charizard" or "Submariner" match graded/variant titles.
function normalizeCourtyardAsset(asset: CourtyardAsset): Erc721InventoryAsset | null {
  const contractAddress = normalizeEthereumAddress(asset.contract)
  const ownerAddress = normalizeEthereumAddress(asset.owner?.address)
  if (!contractAddress || !ownerAddress || !asset.token_id) {
    return null
  }

  const chainNamespace = normalizeCourtyardChainNamespace(asset.chain)
  const facts = normalizeInventoryMetadata(asset)

  return {
    chainNamespace,
    contractAddress,
    tokenId: asset.token_id,
    ownerAddress,
    ...facts,
  }
}

function normalizeCourtyardChainNamespace(chain: string | undefined): string {
  const normalized = normalizeInventoryText(chain)
  if (normalized === "polygon" || normalized === "matic" || normalized === "polygon pos") {
    return "eip155:137"
  }
  if (normalized === "ethereum" || normalized === "eth" || normalized === "mainnet" || normalized === "homestead") {
    return "eip155:1"
  }
  return chain ?? "unknown"
}

function assetMatchesFilter(asset: Erc721InventoryAsset, filter: Erc721InventoryAssetMatch): boolean {
  if (filter.category && asset.category !== filter.category) return false
  if (filter.franchise && asset.franchise !== filter.franchise) return false
  if (filter.subject && !asset.subject?.includes(filter.subject)) return false
  if (filter.brand && asset.brand !== filter.brand) return false
  if (filter.model && !asset.model?.includes(filter.model)) return false
  if (filter.reference && asset.reference !== filter.reference) return false
  if (filter.set && asset.set !== filter.set) return false
  if (filter.year && asset.year !== filter.year) return false
  if (filter.grader && asset.grader !== filter.grader) return false
  if (filter.grade && asset.grade !== filter.grade) return false
  if (filter.condition && asset.condition !== filter.condition) return false
  return true
}

async function fetchCourtyardOwnershipPage(input: {
  env: Env
  owner: string
  offset: number
  limit: number
}): Promise<{ assets: CourtyardAsset[]; total: number }> {
  const configuredApiUrl = String(input.env.COURTYARD_API_URL || DEFAULT_COURTYARD_API_URL).trim() || DEFAULT_COURTYARD_API_URL
  const url = new URL("/index/ownership", configuredApiUrl)
  url.searchParams.set("owner", input.owner)
  url.searchParams.set("walletType", "both")
  url.searchParams.set("offset", String(input.offset))
  url.searchParams.set("limit", String(input.limit))

  const response = await fetch(url, {
    headers: { "user-agent": "Pirate community token gate" },
  })
  if (!response.ok) {
    throw new Error(`Courtyard ownership lookup failed with ${response.status}`)
  }
  const body = await response.json() as { assets?: CourtyardAsset[]; total?: number }
  return {
    assets: Array.isArray(body.assets) ? body.assets : [],
    total: typeof body.total === "number" ? body.total : 0,
  }
}

async function countCourtyardInventoryMatches(input: {
  env: Env
  walletAddresses: string[]
  config: Erc721InventoryMatchConfig
}): Promise<number> {
  let matchedQuantity = 0
  const seenTokenKeys = new Set<string>()
  const pageLimit = 100

  for (const walletAddress of input.walletAddresses) {
    let offset = 0
    while (true) {
      const page = await fetchCourtyardOwnershipPage({ env: input.env, owner: walletAddress, offset, limit: pageLimit })
      for (const rawAsset of page.assets) {
        const asset = normalizeCourtyardAsset(rawAsset)
        if (!asset) continue
        if (
          asset.chainNamespace !== input.config.chainNamespace
          || normalizeEthereumAddress(asset.contractAddress) !== input.config.contractAddress
          || !assetMatchesFilter(asset, input.config.assetFilter)
        ) {
          continue
        }
        const tokenKey = `${asset.chainNamespace}:${asset.contractAddress}:${asset.tokenId}`
        if (seenTokenKeys.has(tokenKey)) continue
        seenTokenKeys.add(tokenKey)
        matchedQuantity += 1
        if (matchedQuantity >= input.config.minQuantity) {
          return matchedQuantity
        }
      }
      offset += page.assets.length
      if (page.assets.length === 0 || offset >= page.total) {
        break
      }
    }
  }

  return matchedQuantity
}

function resolveCourtyardInventoryCacheTtlMs(env: Env): number {
  const raw = String(env.COURTYARD_INVENTORY_CACHE_TTL_MS || "").trim()
  if (!raw) {
    return DEFAULT_COURTYARD_INVENTORY_CACHE_TTL_MS
  }
  const parsed = Number(raw)
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 300_000) {
    return parsed
  }
  return DEFAULT_COURTYARD_INVENTORY_CACHE_TTL_MS
}

function buildInventoryMatchCacheKey(input: {
  walletAddresses: string[]
  config: Erc721InventoryMatchConfig
}): string {
  return JSON.stringify({
    wallets: [...input.walletAddresses].sort(),
    chainNamespace: input.config.chainNamespace,
    contractAddress: input.config.contractAddress,
    inventoryProvider: input.config.inventoryProvider,
    minQuantity: input.config.minQuantity,
    assetFilter: input.config.assetFilter,
  })
}

function sweepExpiredCourtyardInventoryCache(nowMs: number): void {
  for (const [key, entry] of courtyardInventoryMatchCache) {
    if (entry.expiresAtMs <= nowMs) {
      courtyardInventoryMatchCache.delete(key)
    }
  }
}

function setCourtyardInventoryCacheEntry(key: string, entry: CourtyardInventoryCacheEntry, nowMs: number): void {
  sweepExpiredCourtyardInventoryCache(nowMs)
  courtyardInventoryMatchCache.set(key, entry)
  while (courtyardInventoryMatchCache.size > MAX_COURTYARD_INVENTORY_CACHE_ENTRIES) {
    const oldestKey = courtyardInventoryMatchCache.keys().next().value
    if (typeof oldestKey !== "string") {
      break
    }
    courtyardInventoryMatchCache.delete(oldestKey)
  }
}

function logCourtyardInventoryProviderError(input: {
  error: unknown
  walletCount: number
  contractAddress: string
}): void {
  const error = input.error
  console.warn("[courtyard-inventory-gate] provider unavailable", {
    error_name: error instanceof Error ? error.name : typeof error,
    error_message: error instanceof Error ? error.message : String(error),
    wallet_count: input.walletCount,
    contract_address: input.contractAddress,
  })
}

export async function evaluateErc721InventoryMatch(input: {
  env: Env
  walletAttachments: WalletAttachmentSummary[]
  config: Erc721InventoryMatchConfig
}): Promise<{ matchedQuantity: number; unavailable: boolean }> {
  const walletAddresses = listAttachedWalletAddressesForChain(input.walletAttachments, input.config.chainNamespace)
  if (walletAddresses.length === 0) {
    return { matchedQuantity: 0, unavailable: false }
  }

  const cacheKey = buildInventoryMatchCacheKey({ walletAddresses, config: input.config })
  const cacheTtlMs = resolveCourtyardInventoryCacheTtlMs(input.env)
  const cached = courtyardInventoryMatchCache.get(cacheKey)
  const nowMs = Date.now()
  if (cacheTtlMs > 0 && cached && cached.expiresAtMs > nowMs) {
    return { matchedQuantity: cached.matchedQuantity, unavailable: false }
  }

  try {
    const result = erc721InventoryMatcherForTests
      ? await erc721InventoryMatcherForTests({
        env: input.env,
        walletAddresses,
        config: input.config,
      })
      : {
        matchedQuantity: await countCourtyardInventoryMatches({
          env: input.env,
          walletAddresses,
          config: input.config,
        }),
      }
    if (result.unavailable === true) {
      return { matchedQuantity: result.matchedQuantity, unavailable: true }
    }
    if (cacheTtlMs > 0) {
      setCourtyardInventoryCacheEntry(cacheKey, {
        matchedQuantity: result.matchedQuantity,
        expiresAtMs: nowMs + cacheTtlMs,
      }, nowMs)
    }
    return { matchedQuantity: result.matchedQuantity, unavailable: false }
  } catch (error) {
    logCourtyardInventoryProviderError({
      error,
      walletCount: walletAddresses.length,
      contractAddress: input.config.contractAddress,
    })
    return { matchedQuantity: 0, unavailable: true }
  }
}
