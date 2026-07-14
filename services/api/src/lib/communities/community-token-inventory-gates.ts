import type { Env } from "../../env"
import type { WalletAttachmentSummary } from "../../types"
import { DEFAULT_COURTYARD_API_URL, COURTYARD_REGISTRIES } from "./courtyard-registry-config"
import { normalizeEthereumAddress } from "./community-token-gates"

type Erc721InventoryProvider = "courtyard"
type Erc721InventoryAssetCategory = "trading_card" | "watch"
type Erc721InventoryMatchValue = string | string[]
export type Erc721InventoryAssetMatch = {
  category?: Erc721InventoryAssetCategory | Erc721InventoryAssetCategory[]
  franchise?: Erc721InventoryMatchValue
  subject?: Erc721InventoryMatchValue
  brand?: Erc721InventoryMatchValue
  model?: Erc721InventoryMatchValue
  reference?: Erc721InventoryMatchValue
  set?: Erc721InventoryMatchValue
  year?: Erc721InventoryMatchValue
  grader?: Erc721InventoryMatchValue
  grade?: Erc721InventoryMatchValue
  condition?: Erc721InventoryMatchValue
}
export type Erc721InventoryMatchConfig = {
  chainNamespace: "eip155:1" | "eip155:137"
  contractAddress: string
  inventoryProvider: Erc721InventoryProvider
  minQuantity: number
  assetFilter: Erc721InventoryAssetMatch
}

type Erc721InventoryAsset = {
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

export type CourtyardWalletInventoryGroup = {
  category: Erc721InventoryAssetCategory
  chain_namespace: "eip155:1" | "eip155:137"
  contract_address: string
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
  display_label: string
  display_detail: string
  count: number
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

type CourtyardWalletInventoryGroupCacheEntry = {
  result: { groups: CourtyardWalletInventoryGroup[]; unavailable: boolean }
  expiresAtMs: number
}

let erc721InventoryMatcherForTests: ((input: {
  env: Env
  walletAddresses: string[]
  config: Erc721InventoryMatchConfig
}) => Promise<{ matchedQuantity: number; unavailable?: boolean }>) | null = null

const courtyardInventoryMatchCache = new Map<string, CourtyardInventoryCacheEntry>()
const courtyardWalletInventoryGroupCache = new Map<string, CourtyardWalletInventoryGroupCacheEntry>()
const DEFAULT_COURTYARD_INVENTORY_CACHE_TTL_MS = 60_000
const DEFAULT_COURTYARD_WALLET_INVENTORY_GROUP_CACHE_TTL_MS = 30_000
const DEFAULT_COURTYARD_OWNERSHIP_FETCH_TIMEOUT_MS = 8_000
const DEFAULT_COURTYARD_OWNERSHIP_MAX_ASSETS_PER_WALLET = 1_000
const MAX_COURTYARD_INVENTORY_CACHE_ENTRIES = 1_000
export const MAX_INVENTORY_MATCH_VALUES_PER_KEY = 10

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
  courtyardWalletInventoryGroupCache.clear()
}

export function normalizeInventoryText(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().normalize("NFC").normalize("NFD").replace(/\p{Mark}/gu, "").toLowerCase()
  return normalized.length > 0 ? normalized : null
}

function listAttachedEvmWalletAddresses(walletAttachments: WalletAttachmentSummary[]): string[] {
  const seen = new Set<string>()
  const addresses: string[] = []

  for (const attachment of walletAttachments) {
    if (!attachment.chain_namespace.startsWith("eip155:")) {
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

  const category = normalizeInventoryCategoryMatchValue(raw.category)
  if (!category) {
    return null
  }

  const filter: Erc721InventoryAssetMatch = { category }
  for (const key of INVENTORY_MATCH_KEYS) {
    if (key === "category") continue
    const normalized = normalizeInventoryMatchValue(raw[key])
    if (normalized) {
      filter[key] = normalized
    }
  }

  if (Object.keys(filter).length <= 1) {
    return null
  }
  if (matchValueIncludes(category, "trading_card") && !filter.franchise && !filter.subject) {
    return null
  }
  if (matchValueIncludes(category, "watch") && !filter.brand && !filter.model) {
    return null
  }

  return filter
}

export function formatAssetFilterLabel(filter: Erc721InventoryAssetMatch): string {
  const values = INVENTORY_MATCH_KEYS
    .filter((key) => key !== "category")
    .flatMap((key) => matchValueList(filter[key]))
    .filter((value): value is string => Boolean(value))
  return values.join(" ")
}

function normalizeInventoryMatchValue(value: unknown): Erc721InventoryMatchValue | null {
  const values = Array.isArray(value) ? value : [value]
  if (values.length === 0 || values.length > MAX_INVENTORY_MATCH_VALUES_PER_KEY) {
    return null
  }
  const normalizedValues: string[] = []
  for (const raw of values) {
    const normalized = normalizeInventoryText(raw)
    if (!normalized || normalizedValues.includes(normalized)) {
      return null
    }
    normalizedValues.push(normalized)
  }
  return Array.isArray(value) ? normalizedValues : normalizedValues[0]!
}

function normalizeInventoryCategoryMatchValue(value: unknown): Erc721InventoryAssetCategory | Erc721InventoryAssetCategory[] | null {
  const normalized = normalizeInventoryMatchValue(value)
  if (!normalized) {
    return null
  }
  const values = matchValueList(normalized)
  if (values.some((category) => category !== "trading_card" && category !== "watch")) {
    return null
  }
  return Array.isArray(normalized) ? values as Erc721InventoryAssetCategory[] : values[0] as Erc721InventoryAssetCategory
}

function matchValueList(value: Erc721InventoryMatchValue | Erc721InventoryAssetCategory | Erc721InventoryAssetCategory[] | undefined): string[] {
  if (!value) {
    return []
  }
  return Array.isArray(value) ? value : [value]
}

function matchValueIncludes(value: Erc721InventoryMatchValue | Erc721InventoryAssetCategory | Erc721InventoryAssetCategory[] | undefined, candidate: string): boolean {
  return matchValueList(value).includes(candidate)
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
  if (filter.category && !matchExact(asset.category, filter.category)) return false
  if (filter.franchise && !matchExact(asset.franchise, filter.franchise)) return false
  if (filter.subject && !matchContains(asset.subject, filter.subject)) return false
  if (filter.brand && !matchExact(asset.brand, filter.brand)) return false
  if (filter.model && !matchContains(asset.model, filter.model)) return false
  if (filter.reference && !matchExact(asset.reference, filter.reference)) return false
  if (filter.set && !matchExact(asset.set, filter.set)) return false
  if (filter.year && !matchExact(asset.year, filter.year)) return false
  if (filter.grader && !matchExact(asset.grader, filter.grader)) return false
  if (filter.grade && !matchExact(asset.grade, filter.grade)) return false
  if (filter.condition && !matchExact(asset.condition, filter.condition)) return false
  return true
}

function matchExact(assetValue: string | null, filterValue: Erc721InventoryMatchValue | Erc721InventoryAssetCategory | Erc721InventoryAssetCategory[]): boolean {
  if (!assetValue) {
    return false
  }
  return matchValueList(filterValue).includes(assetValue)
}

function matchContains(assetValue: string | null, filterValue: Erc721InventoryMatchValue): boolean {
  if (!assetValue) {
    return false
  }
  return matchValueList(filterValue).some((candidate) => assetValue.includes(candidate))
}

function toTitleWords(value: string): string {
  return value.split(/\s+/u)
    .filter(Boolean)
    .map((word) => word.length <= 3 && /^[a-z0-9]+$/u.test(word)
      ? word.toUpperCase()
      : `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ")
}

function groupFromAsset(asset: Erc721InventoryAsset): Omit<CourtyardWalletInventoryGroup, "count" | "display_detail"> | null {
  if (asset.category !== "trading_card" && asset.category !== "watch") {
    return null
  }
  if (!isAllowedCourtyardRegistry({ chainNamespace: asset.chainNamespace, contractAddress: asset.contractAddress })) {
    return null
  }
  if (asset.chainNamespace !== "eip155:1" && asset.chainNamespace !== "eip155:137") {
    return null
  }

  const base = {
    category: asset.category,
    chain_namespace: asset.chainNamespace,
    contract_address: normalizeEthereumAddress(asset.contractAddress) ?? asset.contractAddress,
  } as const
  if (asset.category === "trading_card") {
    const group = {
      ...base,
      ...(asset.franchise ? { franchise: asset.franchise } : {}),
      ...(asset.subject ? { subject: asset.subject } : {}),
      ...(asset.set ? { set: asset.set } : {}),
      ...(asset.year ? { year: asset.year } : {}),
      ...(asset.grader ? { grader: asset.grader } : {}),
      ...(asset.grade ? { grade: asset.grade } : {}),
    }
    const labelValues = [group.franchise, group.subject, group.set].filter((value): value is string => !!value)
    if (labelValues.length === 0) return null
    return {
      ...group,
      display_label: labelValues.map(toTitleWords).join(" "),
    }
  }

  const group = {
    ...base,
    ...(asset.brand ? { brand: asset.brand } : {}),
    ...(asset.model ? { model: asset.model } : {}),
    ...(asset.reference ? { reference: asset.reference } : {}),
    ...(asset.condition ? { condition: asset.condition } : {}),
  }
  const labelValues = [group.brand, group.model, group.reference].filter((value): value is string => !!value)
  if (labelValues.length === 0) return null
  return {
    ...group,
    display_label: labelValues.map(toTitleWords).join(" "),
  }
}

export async function listCourtyardWalletInventoryGroups(input: {
  env: Env
  walletAttachments: WalletAttachmentSummary[]
}): Promise<{ groups: CourtyardWalletInventoryGroup[]; unavailable: boolean }> {
  const walletAddresses = Array.from(new Set(
    input.walletAttachments
      .filter((wallet) => wallet.chain_namespace === "eip155:1" || wallet.chain_namespace === "eip155:137")
      .map((wallet) => normalizeEthereumAddress(wallet.wallet_address))
      .filter((wallet): wallet is string => !!wallet),
  ))
  if (walletAddresses.length === 0) {
    return { groups: [], unavailable: false }
  }

  const cacheKey = JSON.stringify(walletAddresses.sort())
  const cached = courtyardWalletInventoryGroupCache.get(cacheKey)
  if (cached && cached.expiresAtMs > Date.now()) {
    return {
      groups: cached.result.groups.map((group) => ({ ...group })),
      unavailable: cached.result.unavailable,
    }
  }

  const groups = new Map<string, CourtyardWalletInventoryGroup>()
  const seenTokenKeys = new Set<string>()
  const pageLimit = 100
  const maxAssetsPerWallet = resolveCourtyardOwnershipMaxAssetsPerWallet(input.env)

  try {
    for (const walletAddress of walletAddresses) {
      let offset = 0
      while (offset < maxAssetsPerWallet) {
        const limit = Math.min(pageLimit, maxAssetsPerWallet - offset)
        const page = await fetchCourtyardOwnershipPage({ env: input.env, owner: walletAddress, offset, limit })
        for (const rawAsset of page.assets) {
          const asset = normalizeCourtyardAsset(rawAsset)
          if (!asset) continue
          const tokenKey = `${asset.chainNamespace}:${asset.contractAddress}:${asset.tokenId}`
          if (seenTokenKeys.has(tokenKey)) continue
          seenTokenKeys.add(tokenKey)
          const group = groupFromAsset(asset)
          if (!group) continue
          const groupKey = JSON.stringify(group)
          const current = groups.get(groupKey)
          groups.set(groupKey, {
            ...group,
            count: (current?.count ?? 0) + 1,
            display_detail: `${(current?.count ?? 0) + 1} in wallet`,
          })
        }
        offset += page.assets.length
        if (page.assets.length === 0 || offset >= page.total || offset >= maxAssetsPerWallet) {
          break
        }
      }
    }
  } catch (error) {
    logCourtyardInventoryProviderError({
      error,
      walletCount: walletAddresses.length,
      contractAddress: "inventory-list",
    })
    return { groups: [], unavailable: true }
  }

  const result = {
    groups: Array.from(groups.values()).sort((a, b) => a.display_label.localeCompare(b.display_label)),
    unavailable: false,
  }
  if (courtyardWalletInventoryGroupCache.size >= MAX_COURTYARD_INVENTORY_CACHE_ENTRIES) {
    courtyardWalletInventoryGroupCache.clear()
  }
  courtyardWalletInventoryGroupCache.set(cacheKey, {
    result: {
      groups: result.groups.map((group) => ({ ...group })),
      unavailable: result.unavailable,
    },
    expiresAtMs: Date.now() + DEFAULT_COURTYARD_WALLET_INVENTORY_GROUP_CACHE_TTL_MS,
  })
  return result
}

function resolveCourtyardOwnershipFetchTimeoutMs(env: Env): number {
  const raw = String(env.COURTYARD_OWNERSHIP_FETCH_TIMEOUT_MS || "").trim()
  if (!raw) {
    return DEFAULT_COURTYARD_OWNERSHIP_FETCH_TIMEOUT_MS
  }
  const parsed = Number(raw)
  if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 30_000) {
    return parsed
  }
  return DEFAULT_COURTYARD_OWNERSHIP_FETCH_TIMEOUT_MS
}

function resolveCourtyardOwnershipMaxAssetsPerWallet(env: Env): number {
  const raw = String(env.COURTYARD_OWNERSHIP_MAX_ASSETS_PER_WALLET || "").trim()
  if (!raw) {
    return DEFAULT_COURTYARD_OWNERSHIP_MAX_ASSETS_PER_WALLET
  }
  const parsed = Number(raw)
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 5_000) {
    return parsed
  }
  return DEFAULT_COURTYARD_OWNERSHIP_MAX_ASSETS_PER_WALLET
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

  const timeoutMs = resolveCourtyardOwnershipFetchTimeoutMs(input.env)
  const abortController = new AbortController()
  const timeoutId = setTimeout(() => abortController.abort(new Error("Courtyard ownership lookup timed out")), timeoutMs)
  let response: Response
  try {
    response = await fetch(url, {
      headers: { "user-agent": "Pirate community token gate" },
      signal: abortController.signal,
    })
  } finally {
    clearTimeout(timeoutId)
  }
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
  const maxAssetsPerWallet = resolveCourtyardOwnershipMaxAssetsPerWallet(input.env)

  for (const walletAddress of input.walletAddresses) {
    let offset = 0
    while (offset < maxAssetsPerWallet) {
      const limit = Math.min(pageLimit, maxAssetsPerWallet - offset)
      const page = await fetchCourtyardOwnershipPage({ env: input.env, owner: walletAddress, offset, limit })
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
      if (page.assets.length === 0 || offset >= page.total || offset >= maxAssetsPerWallet) {
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
  const walletAddresses = listAttachedEvmWalletAddresses(input.walletAttachments)
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
