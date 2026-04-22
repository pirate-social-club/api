import { COURTYARD_REGISTRIES } from "../src/lib/communities/courtyard-registry-config"
import {
  normalizeAssetMatch,
  normalizeInventoryMetadata,
  type RawInventoryAttribute,
} from "../src/lib/communities/community-token-inventory-gates"
import { normalizeEthereumAddress } from "../src/lib/communities/community-token-gates"

type AlchemyAttribute = RawInventoryAttribute & {
  display_type?: string
}

type AlchemyNft = {
  contract?: {
    address?: string
    name?: string
    openSeaMetadata?: {
      collectionName?: string
    }
  }
  collection?: {
    name?: string
  }
  name?: string
  title?: string
  tokenId?: string
  tokenIdHex?: string
  id?: {
    tokenId?: string
  }
  metadata?: {
    attributes?: AlchemyAttribute[]
    name?: string
    title?: string
  }
  raw?: {
    metadata?: {
      attributes?: AlchemyAttribute[]
      name?: string
      title?: string
    }
  }
  rawMetadata?: {
    attributes?: AlchemyAttribute[]
    name?: string
    title?: string
  }
}

type AlchemyNftsForOwnerResponse = {
  ownedNfts?: AlchemyNft[]
  pageKey?: string | null
}

type CourtyardIndexedAsset = {
  attributes?: RawInventoryAttribute[]
  chain?: string
  collection?: string
  contract?: string
  owner?: { address?: string }
  title?: string
  token_id?: string
}

type MatchedNft = {
  tokenId: string | null
  name: string | null
  collection: string | null
  facts: ReturnType<typeof normalizeInventoryMetadata>
}

type SupportedChain = "ethereum" | "polygon"

function readSupportedChain(): SupportedChain {
  const raw = readArg("--chain") ?? "polygon"
  if (raw === "ethereum" || raw === "eth" || raw === "mainnet" || raw === "eip155:1") {
    return "ethereum"
  }
  if (raw === "polygon" || raw === "matic" || raw === "eip155:137") {
    return "polygon"
  }
  throw new Error("--chain must be ethereum or polygon")
}

function chainNamespaceFor(chain: SupportedChain): "eip155:1" | "eip155:137" {
  return chain === "ethereum" ? "eip155:1" : "eip155:137"
}

function alchemyNetworkFor(chain: SupportedChain): string {
  return chain === "ethereum" ? "eth-mainnet" : "polygon-mainnet"
}

function requireCourtyardRegistry(chain: SupportedChain): (typeof COURTYARD_REGISTRIES)[number] {
  const chainNamespace = chainNamespaceFor(chain)
  const value = COURTYARD_REGISTRIES.find((entry) => entry.chainNamespace === chainNamespace)
  if (!value) {
    throw new Error(`Missing Courtyard registry config for ${chainNamespace}`)
  }
  return value
}

const ROLEX_MATCH = normalizeAssetMatch({
  category: "watch",
  brand: "rolex",
})
if (!ROLEX_MATCH) {
  throw new Error("Invalid Rolex inventory match config")
}

function readArg(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1] ?? null
}

function readIntArg(name: string, fallback: number, input: { min: number; max: number }): number {
  const raw = readArg(name)
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isInteger(parsed) || parsed < input.min || parsed > input.max) {
    throw new Error(`${name} must be an integer from ${input.min} to ${input.max}`)
  }
  return parsed
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value
    }
  }
  return null
}

function readAlchemyAttributes(nft: AlchemyNft): AlchemyAttribute[] {
  const sources = [
    nft.raw?.metadata?.attributes,
    nft.rawMetadata?.attributes,
    nft.metadata?.attributes,
  ]
  return sources.flatMap((attributes) => Array.isArray(attributes) ? attributes : [])
}

function normalizeAlchemyNft(nft: AlchemyNft): MatchedNft {
  const collection = firstString(
    nft.contract?.openSeaMetadata?.collectionName,
    nft.collection?.name,
    nft.contract?.name,
  )
  const name = firstString(
    nft.name,
    nft.title,
    nft.raw?.metadata?.name,
    nft.raw?.metadata?.title,
    nft.rawMetadata?.name,
    nft.rawMetadata?.title,
    nft.metadata?.name,
    nft.metadata?.title,
  )

  return {
    tokenId: firstString(nft.tokenId, nft.tokenIdHex, nft.id?.tokenId),
    name,
    collection,
    facts: normalizeInventoryMetadata({
      attributes: readAlchemyAttributes(nft),
      collection: collection ?? undefined,
      title: name ?? undefined,
      name: name ?? undefined,
    }),
  }
}

function isRolexWatch(match: MatchedNft): boolean {
  return match.facts.category === "watch" && match.facts.brand === "rolex"
}

function buildGateRule(input: {
  registry: (typeof COURTYARD_REGISTRIES)[number]
  minQuantity: number
}): Record<string, unknown> {
  return {
    scope: "membership",
    gate_family: "token_holding",
    gate_type: "erc721_inventory_match",
    chain_namespace: input.registry.chainNamespace,
    proof_requirements: [],
    gate_config: {
      contract_address: input.registry.contractAddress,
      inventory_provider: "courtyard",
      min_quantity: input.minQuantity,
      match: ROLEX_MATCH,
    },
  }
}

function buildGatesPatchBody(input: {
  registry: (typeof COURTYARD_REGISTRIES)[number]
  minQuantity: number
}): Record<string, unknown> {
  return {
    membership_mode: "gated",
    default_age_gate_policy: "none",
    allow_anonymous_identity: false,
    anonymous_identity_scope: null,
    gate_rules: [buildGateRule(input)],
  }
}

function buildAlchemyUrl(input: {
  apiKey: string
  chain: SupportedChain
  owner: string
  registry: (typeof COURTYARD_REGISTRIES)[number]
  pageKey: string | null
}): URL {
  const url = new URL(`https://${alchemyNetworkFor(input.chain)}.g.alchemy.com/nft/v3/${input.apiKey}/getNFTsForOwner`)
  url.searchParams.set("owner", input.owner)
  url.searchParams.append("contractAddresses[]", input.registry.contractAddress)
  url.searchParams.set("withMetadata", "true")
  url.searchParams.set("pageSize", "100")
  if (input.pageKey) {
    url.searchParams.set("pageKey", input.pageKey)
  }
  return url
}

async function fetchAlchemyPage(input: {
  apiKey: string
  chain: SupportedChain
  owner: string
  registry: (typeof COURTYARD_REGISTRIES)[number]
  pageKey: string | null
}): Promise<AlchemyNftsForOwnerResponse> {
  const response = await fetch(buildAlchemyUrl(input), {
    headers: { "user-agent": "Pirate admin Courtyard Rolex gate proof" },
  })
  if (!response.ok) {
    throw new Error(`Alchemy getNFTsForOwner failed with ${response.status}`)
  }
  return response.json() as Promise<AlchemyNftsForOwnerResponse>
}

async function proveWithAlchemy(input: {
  apiKey: string
  chain: SupportedChain
  owner: string
  registry: (typeof COURTYARD_REGISTRIES)[number]
  minQuantity: number
  maxPages: number
}): Promise<Record<string, unknown>> {
  const matched: MatchedNft[] = []
  const sampled: MatchedNft[] = []
  let pageKey: string | null = null
  let pagesRead = 0
  let nftsRead = 0

  while (pagesRead < input.maxPages) {
    const page = await fetchAlchemyPage({
      apiKey: input.apiKey,
      chain: input.chain,
      owner: input.owner,
      registry: input.registry,
      pageKey,
    })
    pagesRead += 1

    for (const nft of page.ownedNfts ?? []) {
      const normalized = normalizeAlchemyNft(nft)
      nftsRead += 1
      if (sampled.length < 5) {
        sampled.push(normalized)
      }
      if (isRolexWatch(normalized)) {
        matched.push(normalized)
      }
    }

    if (matched.length >= input.minQuantity) {
      return {
        proofRun: true,
        verified: true,
        source: "alchemy_getNFTsForOwner",
        chain: chainNamespaceFor(input.chain),
        owner: input.owner,
        contractAddress: input.registry.contractAddress,
        pagesRead,
        nftsRead,
        exhaustive: false,
        matchedQuantity: matched.length,
        requiredQuantity: input.minQuantity,
        matchedSamples: matched.slice(0, 10),
        sampledNfts: sampled,
      }
    }

    pageKey = page.pageKey ?? null
    if (!pageKey) {
      break
    }
  }

  return {
    proofRun: true,
    verified: false,
    source: "alchemy_getNFTsForOwner",
    chain: chainNamespaceFor(input.chain),
    owner: input.owner,
    contractAddress: input.registry.contractAddress,
    pagesRead,
    nftsRead,
    exhaustive: pageKey == null,
    truncatedByMaxPages: pageKey != null,
    matchedQuantity: matched.length,
    requiredQuantity: input.minQuantity,
    matchedSamples: matched.slice(0, 10),
    sampledNfts: sampled,
  }
}

async function readCourtyardPublicAlchemyApiKey(): Promise<string | null> {
  const response = await fetch("https://courtyard.io/api/config", {
    headers: { "user-agent": "Mozilla/5.0 Pirate admin Courtyard gate proof" },
  }).catch(() => null)
  if (!response?.ok) {
    return null
  }
  const body = await response.json().catch(() => null) as { alchemyApiKey?: unknown } | null
  return typeof body?.alchemyApiKey === "string" && body.alchemyApiKey.trim().length > 0
    ? body.alchemyApiKey.trim()
    : null
}

function readAttribute(attributes: RawInventoryAttribute[] | undefined, key: string): string | null {
  const normalizedKey = key.trim().toLowerCase()
  for (const attribute of attributes ?? []) {
    const attrKey = String(attribute.name ?? attribute.trait_type ?? attribute.traitType ?? "").trim().toLowerCase()
    if (attrKey === normalizedKey && typeof attribute.value === "string" && attribute.value.trim().length > 0) {
      return attribute.value.trim()
    }
  }
  return null
}

function chainFromCourtyardAsset(asset: CourtyardIndexedAsset): SupportedChain | null {
  const chain = String(asset.chain ?? "").trim().toLowerCase()
  if (chain === "polygon" || chain === "matic" || chain === "polygon pos") {
    return "polygon"
  }
  if (chain === "ethereum" || chain === "eth" || chain === "mainnet" || chain === "homestead") {
    return "ethereum"
  }
  return null
}

async function discoverRolexOwnerFromCourtyardIndex(maxPages: number): Promise<{
  owner: string
  chain: SupportedChain
  asset: Record<string, unknown>
} | null> {
  const configResponse = await fetch("https://courtyard.io/api/config", {
    headers: { "user-agent": "Mozilla/5.0 Pirate admin Courtyard gate proof" },
  })
  if (!configResponse.ok) {
    return null
  }
  const config = await configResponse.json() as { courtyardApiUrl?: string }
  if (!config.courtyardApiUrl) {
    return null
  }

  let offset = 0
  const limit = 100
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL("/index/query", config.courtyardApiUrl)
    url.searchParams.set("collection", "Watches")
    url.searchParams.set("offset", String(offset))
    url.searchParams.set("limit", String(limit))

    const response = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 Pirate admin Courtyard gate proof" },
    })
    if (!response.ok) {
      return null
    }
    const body = await response.json() as { assets?: CourtyardIndexedAsset[]; total?: number }
    const assets = body.assets ?? []
    for (const asset of assets) {
      const owner = normalizeEthereumAddress(asset.owner?.address)
      const chain = chainFromCourtyardAsset(asset)
      const brand = readAttribute(asset.attributes, "Brand")
      if (owner && chain && brand?.trim().toLowerCase() === "rolex") {
        return {
          owner,
          chain,
          asset: {
            chain: asset.chain ?? null,
            contract: asset.contract ?? null,
            tokenId: asset.token_id ?? null,
            owner,
            title: asset.title ?? null,
            collection: asset.collection ?? null,
            brand,
            reference: readAttribute(asset.attributes, "Reference"),
            year: readAttribute(asset.attributes, "Year"),
            condition: readAttribute(asset.attributes, "Condition"),
          },
        }
      }
    }
    offset += assets.length
    if (assets.length === 0 || offset >= (body.total ?? 0)) {
      break
    }
  }
  return null
}

async function main(): Promise<void> {
  let chain = readSupportedChain()
  const discoverRolexOwner = process.argv.includes("--discover-rolex-owner")
  const discoveredRolex = discoverRolexOwner
    ? await discoverRolexOwnerFromCourtyardIndex(readIntArg("--discovery-pages", 10, { min: 1, max: 100 }))
    : null
  if (discoveredRolex) {
    chain = discoveredRolex.chain
  }
  const registry = requireCourtyardRegistry(chain)
  const owner = normalizeEthereumAddress(readArg("--owner") ?? readArg("--wallet")) ?? discoveredRolex?.owner ?? null
  const apiKey = String(process.env.ALCHEMY_API_KEY ?? "").trim() || await readCourtyardPublicAlchemyApiKey()
  const communityId = readArg("--community-id")
  const minQuantity = readIntArg("--min-quantity", 1, { min: 1, max: 100 })
  const maxPages = readIntArg("--max-pages", 20, { min: 1, max: 100 })
  const proof = owner && apiKey
    ? await proveWithAlchemy({ apiKey, chain, owner, registry, minQuantity, maxPages })
    : {
      proofRun: false,
      verified: false,
      reason: owner
        ? "Set ALCHEMY_API_KEY to verify this owner through Alchemy."
        : "Pass --owner 0x... and set ALCHEMY_API_KEY to verify a wallet through Alchemy.",
    }

  console.log(JSON.stringify({
    adminReady: true,
    adminUseCase: "Courtyard Rolex membership gate",
    communityId: communityId ?? null,
    chain: chainNamespaceFor(chain),
    registry: {
      label: registry.label,
      contractAddress: registry.contractAddress,
    },
    discoveredRolex,
    createGateRule: buildGateRule({ registry, minQuantity }),
    updateGatesRequest: {
      method: "PUT",
      path: communityId ? `/communities/${communityId}/gates` : "/communities/{communityId}/gates",
      body: buildGatesPatchBody({ registry, minQuantity }),
    },
    alchemyProof: proof,
    notes: [
      "This admin gate does not require the admin wallet to own a Rolex.",
      "Alchemy proof verifies a known wallet against the selected Courtyard registry metadata.",
      "Runtime entitlement still uses the backend inventory gate evaluator and fails closed on provider errors.",
    ],
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
