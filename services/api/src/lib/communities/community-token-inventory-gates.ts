import type { Env, WalletAttachmentSummary } from "../../types"
import { COURTYARD_API_URL, COURTYARD_REGISTRIES } from "./courtyard-registry-config"
import { normalizeEthereumAddress } from "./community-token-gates"

export type Erc721InventoryProvider = "courtyard"
export type Erc721InventoryAssetCategory = "trading_card" | "watch"
export type Erc721InventoryAssetFilter = {
  category?: Erc721InventoryAssetCategory
  franchise?: string
  subject?: string
  brand?: string
  model?: string
}

export type Erc721InventoryMatchConfig = {
  chainNamespace: "eip155:137"
  contractAddress: string
  inventoryProvider: Erc721InventoryProvider
  minQuantity: number
  assetFilter: Erc721InventoryAssetFilter
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
}

type CourtyardAsset = {
  attributes?: Array<{ name?: string; value?: string }>
  chain?: string
  collection?: string
  contract?: string
  owner?: { address?: string }
  title?: string
  token_id?: string
}

let erc721InventoryMatcherForTests: ((input: {
  env: Env
  walletAddresses: string[]
  config: Erc721InventoryMatchConfig
}) => Promise<{ matchedQuantity: number; unavailable?: boolean }>) | null = null

export function setErc721InventoryMatcherForTests(
  matcher: ((input: {
    env: Env
    walletAddresses: string[]
    config: Erc721InventoryMatchConfig
  }) => Promise<{ matchedQuantity: number; unavailable?: boolean }>) | null,
): void {
  erc721InventoryMatcherForTests = matcher
}

export function normalizeInventoryText(value: unknown): string | null {
  if (typeof value !== "string") return null
  const normalized = value.trim().normalize("NFC").normalize("NFD").replace(/\p{Mark}/gu, "").toLowerCase()
  return normalized.length > 0 ? normalized : null
}

export function listAttachedEvmWalletAddresses(walletAttachments: WalletAttachmentSummary[]): string[] {
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
  if (!gateConfig || chainNamespace !== "eip155:137") {
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
  const assetFilter = normalizeAssetFilter(gateConfig.asset_filter)
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

export function normalizeAssetFilter(value: unknown): Erc721InventoryAssetFilter | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }

  const raw = value as Record<string, unknown>
  const allowedKeys = new Set(["category", "franchise", "subject", "brand", "model"])
  if (Object.keys(raw).some((key) => !allowedKeys.has(key))) {
    return null
  }

  const category = normalizeInventoryText(raw.category)
  if (category !== "trading_card" && category !== "watch") {
    return null
  }

  const filter: Erc721InventoryAssetFilter = { category }
  const franchise = normalizeInventoryText(raw.franchise)
  const subject = normalizeInventoryText(raw.subject)
  const brand = normalizeInventoryText(raw.brand)
  const model = normalizeInventoryText(raw.model)
  if (franchise) filter.franchise = franchise
  if (subject) filter.subject = subject
  if (brand) filter.brand = brand
  if (model) filter.model = model

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

export function formatAssetFilterLabel(filter: Erc721InventoryAssetFilter): string {
  const values = [
    filter.franchise,
    filter.subject,
    filter.brand,
    filter.model,
  ].filter((value): value is string => Boolean(value))
  return values.join(" ")
}

function readCourtyardAttributes(asset: CourtyardAsset): Record<string, string> {
  const values: Record<string, string> = {}
  for (const attribute of asset.attributes ?? []) {
    const key = normalizeInventoryText(attribute.name)
    const value = normalizeInventoryText(attribute.value)
    if (key && value) values[key] = value
  }
  return values
}

function normalizeCourtyardAsset(asset: CourtyardAsset): Erc721InventoryAsset | null {
  const contractAddress = normalizeEthereumAddress(asset.contract)
  const ownerAddress = normalizeEthereumAddress(asset.owner?.address)
  if (!contractAddress || !ownerAddress || !asset.token_id) {
    return null
  }

  const attributes = readCourtyardAttributes(asset)
  const collection = normalizeInventoryText(asset.collection) ?? ""
  const title = normalizeInventoryText(asset.title) ?? ""
  const chainNamespace = asset.chain === "polygon" ? "eip155:137" : asset.chain ?? "unknown"
  const category = collection.includes("watch") || title.includes("watch")
    ? "watch"
    : collection.includes("card") || collection.includes("booster") || attributes.grader || attributes.grade
      ? "trading_card"
      : "unknown"

  return {
    chainNamespace,
    contractAddress,
    tokenId: asset.token_id,
    ownerAddress,
    category,
    franchise: category === "trading_card" ? attributes.category ?? null : null,
    subject: attributes["title/subject"] ?? attributes["title/pkmn"] ?? null,
    brand: attributes.brand ?? null,
    model: attributes.model ?? attributes.reference ?? null,
  }
}

function assetMatchesFilter(asset: Erc721InventoryAsset, filter: Erc721InventoryAssetFilter): boolean {
  if (filter.category && asset.category !== filter.category) return false
  if (filter.franchise && asset.franchise !== filter.franchise) return false
  if (filter.subject && !asset.subject?.includes(filter.subject)) return false
  if (filter.brand && asset.brand !== filter.brand) return false
  if (filter.model && !asset.model?.includes(filter.model)) return false
  return true
}

async function fetchCourtyardOwnershipPage(input: {
  owner: string
  offset: number
  limit: number
}): Promise<{ assets: CourtyardAsset[]; total: number }> {
  const url = new URL("/index/ownership", COURTYARD_API_URL)
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
  walletAddresses: string[]
  config: Erc721InventoryMatchConfig
}): Promise<number> {
  let matchedQuantity = 0
  const seenTokenKeys = new Set<string>()
  const pageLimit = 100
  const maxAssetsPerWallet = 1_000

  for (const walletAddress of input.walletAddresses) {
    let offset = 0
    while (offset < maxAssetsPerWallet) {
      const page = await fetchCourtyardOwnershipPage({ owner: walletAddress, offset, limit: pageLimit })
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

export async function evaluateErc721InventoryMatch(input: {
  env: Env
  walletAttachments: WalletAttachmentSummary[]
  config: Erc721InventoryMatchConfig
}): Promise<{ matchedQuantity: number; unavailable: boolean }> {
  const walletAddresses = listAttachedEvmWalletAddresses(input.walletAttachments)
  if (walletAddresses.length === 0) {
    return { matchedQuantity: 0, unavailable: false }
  }

  if (erc721InventoryMatcherForTests) {
    const result = await erc721InventoryMatcherForTests({
      env: input.env,
      walletAddresses,
      config: input.config,
    })
    return {
      matchedQuantity: result.matchedQuantity,
      unavailable: result.unavailable === true,
    }
  }

  try {
    return {
      matchedQuantity: await countCourtyardInventoryMatches({
        walletAddresses,
        config: input.config,
      }),
      unavailable: false,
    }
  } catch {
    return { matchedQuantity: 0, unavailable: true }
  }
}
