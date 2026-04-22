import { COURTYARD_REGISTRIES } from "../src/lib/communities/courtyard-registry-config"
import {
  normalizeAssetMatch,
  normalizeInventoryMetadata,
  normalizeInventoryText,
  type Erc721InventoryAssetMatch,
  type RawInventoryAttribute,
} from "../src/lib/communities/community-token-inventory-gates"
import { normalizeEthereumAddress } from "../src/lib/communities/community-token-gates"

type SupportedChain = "ethereum" | "polygon"

type CourtyardIndexedAsset = {
  attributes?: RawInventoryAttribute[]
  chain?: string
  collection?: string
  contract?: string
  owner?: { address?: string; username?: string; user_id?: string }
  title?: string
  token_id?: string
}

type AlchemyNft = {
  contract?: {
    address?: string
    name?: string
    openSeaMetadata?: { collectionName?: string }
  }
  collection?: { name?: string }
  name?: string
  title?: string
  tokenId?: string
  tokenIdHex?: string
  id?: { tokenId?: string }
  metadata?: { attributes?: RawInventoryAttribute[]; name?: string; title?: string }
  raw?: { metadata?: { attributes?: RawInventoryAttribute[]; name?: string; title?: string } }
  rawMetadata?: { attributes?: RawInventoryAttribute[]; name?: string; title?: string }
}

type AlchemyNftsForOwnerResponse = {
  ownedNfts?: AlchemyNft[]
  pageKey?: string | null
}

type NormalizedFacts = ReturnType<typeof normalizeInventoryMetadata>

const DEFAULT_MIN_QUANTITY = 1

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
    if (typeof value === "string" && value.trim().length > 0) return value.trim()
  }
  return null
}

function extractAssetId(value: string | null): string {
  if (!value) {
    throw new Error("--asset is required")
  }
  const trimmed = value.trim()
  const match = trimmed.match(/(?:\/asset\/)?([a-fA-F0-9]{64})(?:[/?#].*)?$/u)
  if (!match?.[1]) {
    throw new Error("--asset must be a Courtyard asset URL or 64-character asset id")
  }
  return match[1].toLowerCase()
}

function chainFromCourtyardAsset(asset: CourtyardIndexedAsset): SupportedChain {
  const chain = String(asset.chain ?? "").trim().toLowerCase()
  if (chain === "polygon" || chain === "matic" || chain === "polygon pos") return "polygon"
  if (chain === "ethereum" || chain === "eth" || chain === "mainnet" || chain === "homestead") return "ethereum"
  throw new Error(`Unsupported Courtyard asset chain: ${asset.chain ?? "unknown"}`)
}

function chainNamespaceFor(chain: SupportedChain): "eip155:1" | "eip155:137" {
  return chain === "ethereum" ? "eip155:1" : "eip155:137"
}

function alchemyNetworkFor(chain: SupportedChain): string {
  return chain === "ethereum" ? "eth-mainnet" : "polygon-mainnet"
}

function requireCourtyardRegistry(input: {
  chain: SupportedChain
  contractAddress: string | undefined
}): (typeof COURTYARD_REGISTRIES)[number] {
  const contractAddress = normalizeEthereumAddress(input.contractAddress)
  const chainNamespace = chainNamespaceFor(input.chain)
  const registry = COURTYARD_REGISTRIES.find((entry) => (
    entry.chainNamespace === chainNamespace
    && normalizeEthereumAddress(entry.contractAddress) === contractAddress
  ))
  if (!registry) {
    throw new Error(`Asset is not on an allowlisted Courtyard registry: ${chainNamespace} ${input.contractAddress ?? ""}`)
  }
  return registry
}

async function readCourtyardApiUrl(): Promise<string> {
  const response = await fetch("https://courtyard.io/api/config", {
    headers: { "user-agent": "Mozilla/5.0 Pirate admin Courtyard asset gate" },
  })
  if (!response.ok) {
    throw new Error(`Courtyard config failed with ${response.status}`)
  }
  const body = await response.json() as { courtyardApiUrl?: string }
  if (!body.courtyardApiUrl) {
    throw new Error("Courtyard config did not include courtyardApiUrl")
  }
  return body.courtyardApiUrl
}

async function readCourtyardPublicAlchemyApiKey(): Promise<string | null> {
  const response = await fetch("https://courtyard.io/api/config", {
    headers: { "user-agent": "Mozilla/5.0 Pirate admin Courtyard asset gate" },
  }).catch(() => null)
  if (!response?.ok) return null
  const body = await response.json().catch(() => null) as { alchemyApiKey?: unknown } | null
  return typeof body?.alchemyApiKey === "string" && body.alchemyApiKey.trim().length > 0
    ? body.alchemyApiKey.trim()
    : null
}

async function fetchCourtyardAsset(assetId: string): Promise<CourtyardIndexedAsset> {
  const apiUrl = await readCourtyardApiUrl()
  const response = await fetch(new URL(`/index/asset/${assetId}`, apiUrl), {
    headers: { "user-agent": "Mozilla/5.0 Pirate admin Courtyard asset gate" },
  })
  if (!response.ok) {
    throw new Error(`Courtyard asset lookup failed with ${response.status}`)
  }
  return response.json() as Promise<CourtyardIndexedAsset>
}

function normalizeCourtyardAsset(asset: CourtyardIndexedAsset): NormalizedFacts {
  return normalizeInventoryMetadata({
    attributes: asset.attributes,
    collection: asset.collection,
    title: asset.title,
    name: asset.title,
  })
}

function pokemonCreatureSubject(subject: string | null): string | null {
  if (!subject) return null
  const withoutTrainerPrefix = subject.replace(/^.+?'s\s+/u, "")
  return normalizeInventoryText(withoutTrainerPrefix)
}

function compactMatch(value: Erc721InventoryAssetMatch): Erc721InventoryAssetMatch | null {
  const normalized = normalizeAssetMatch(value)
  return normalized
}

function buildRecommendedMatch(facts: NormalizedFacts): Erc721InventoryAssetMatch | null {
  if (facts.category === "watch") {
    return compactMatch({
      category: "watch",
      brand: facts.brand ?? undefined,
    })
  }
  if (facts.category === "trading_card") {
    return compactMatch({
      category: "trading_card",
      franchise: facts.franchise ?? undefined,
      subject: pokemonCreatureSubject(facts.subject) ?? facts.subject ?? undefined,
    })
  }
  return null
}

function buildSpecificMatch(facts: NormalizedFacts): Erc721InventoryAssetMatch | null {
  if (facts.category === "watch") {
    return compactMatch({
      category: "watch",
      brand: facts.brand ?? undefined,
      reference: facts.reference ?? undefined,
      year: facts.year ?? undefined,
      condition: facts.condition ?? undefined,
    })
  }
  if (facts.category === "trading_card") {
    return compactMatch({
      category: "trading_card",
      franchise: facts.franchise ?? undefined,
      subject: facts.subject ?? undefined,
      set: facts.set ?? undefined,
      year: facts.year ?? undefined,
      grader: facts.grader ?? undefined,
      grade: facts.grade ?? undefined,
    })
  }
  return null
}

function buildGateRule(input: {
  registry: (typeof COURTYARD_REGISTRIES)[number]
  minQuantity: number
  match: Erc721InventoryAssetMatch
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
      match: input.match,
    },
  }
}

function readAlchemyAttributes(nft: AlchemyNft): RawInventoryAttribute[] {
  const sources = [
    nft.raw?.metadata?.attributes,
    nft.rawMetadata?.attributes,
    nft.metadata?.attributes,
  ]
  return sources.flatMap((attributes) => Array.isArray(attributes) ? attributes : [])
}

function normalizeAlchemyNft(nft: AlchemyNft): {
  tokenId: string | null
  name: string | null
  facts: NormalizedFacts
} {
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
    facts: normalizeInventoryMetadata({
      attributes: readAlchemyAttributes(nft),
      collection: collection ?? undefined,
      title: name ?? undefined,
      name: name ?? undefined,
    }),
  }
}

function factsMatch(asset: NormalizedFacts, match: Erc721InventoryAssetMatch): boolean {
  if (match.category && asset.category !== match.category) return false
  if (match.franchise && asset.franchise !== match.franchise) return false
  if (match.subject && !asset.subject?.includes(match.subject)) return false
  if (match.brand && asset.brand !== match.brand) return false
  if (match.model && !asset.model?.includes(match.model)) return false
  if (match.reference && asset.reference !== match.reference) return false
  if (match.set && asset.set !== match.set) return false
  if (match.year && asset.year !== match.year) return false
  if (match.grader && asset.grader !== match.grader) return false
  if (match.grade && asset.grade !== match.grade) return false
  if (match.condition && asset.condition !== match.condition) return false
  return true
}

async function proveOwnerWithAlchemy(input: {
  apiKey: string
  chain: SupportedChain
  registry: (typeof COURTYARD_REGISTRIES)[number]
  owner: string
  tokenId: string | undefined
  match: Erc721InventoryAssetMatch
  maxPages: number
}): Promise<Record<string, unknown>> {
  let pageKey: string | null = null
  let pagesRead = 0
  let nftsRead = 0
  const matchedSamples: Array<Record<string, unknown>> = []

  while (pagesRead < input.maxPages) {
    const url = new URL(`https://${alchemyNetworkFor(input.chain)}.g.alchemy.com/nft/v3/${input.apiKey}/getNFTsForOwner`)
    url.searchParams.set("owner", input.owner)
    url.searchParams.append("contractAddresses[]", input.registry.contractAddress)
    url.searchParams.set("withMetadata", "true")
    url.searchParams.set("pageSize", "100")
    if (pageKey) url.searchParams.set("pageKey", pageKey)

    const response = await fetch(url, {
      headers: { "user-agent": "Pirate admin Courtyard asset gate" },
    })
    if (!response.ok) {
      throw new Error(`Alchemy getNFTsForOwner failed with ${response.status}`)
    }
    const body = await response.json() as AlchemyNftsForOwnerResponse
    pagesRead += 1

    for (const nft of body.ownedNfts ?? []) {
      nftsRead += 1
      const normalized = normalizeAlchemyNft(nft)
      const isSameToken = input.tokenId ? normalized.tokenId === input.tokenId : false
      if (isSameToken || factsMatch(normalized.facts, input.match)) {
        matchedSamples.push({
          tokenId: normalized.tokenId,
          name: normalized.name,
          sameToken: isSameToken,
          facts: normalized.facts,
        })
      }
    }

    if (matchedSamples.length > 0) break
    pageKey = body.pageKey ?? null
    if (!pageKey) break
  }

  return {
    proofRun: true,
    verified: matchedSamples.length > 0,
    source: "alchemy_getNFTsForOwner",
    chain: input.registry.chainNamespace,
    owner: input.owner,
    contractAddress: input.registry.contractAddress,
    tokenId: input.tokenId ?? null,
    pagesRead,
    nftsRead,
    matchedQuantity: matchedSamples.length,
    matchedSamples,
  }
}

async function main(): Promise<void> {
  const assetId = extractAssetId(readArg("--asset"))
  const minQuantity = readIntArg("--min-quantity", DEFAULT_MIN_QUANTITY, { min: 1, max: 100 })
  const maxPages = readIntArg("--max-pages", 20, { min: 1, max: 100 })
  const asset = await fetchCourtyardAsset(assetId)
  const chain = chainFromCourtyardAsset(asset)
  const registry = requireCourtyardRegistry({ chain, contractAddress: asset.contract })
  const facts = normalizeCourtyardAsset(asset)
  const recommendedMatch = buildRecommendedMatch(facts)
  const specificMatch = buildSpecificMatch(facts)
  if (!recommendedMatch || !specificMatch) {
    throw new Error("Could not derive a supported gate match from this Courtyard asset")
  }

  const owner = normalizeEthereumAddress(asset.owner?.address)
  const apiKey = String(process.env.ALCHEMY_API_KEY ?? "").trim() || await readCourtyardPublicAlchemyApiKey()
  const proof = owner && apiKey
    ? await proveOwnerWithAlchemy({
      apiKey,
      chain,
      registry,
      owner,
      tokenId: asset.token_id,
      match: recommendedMatch,
      maxPages,
    })
    : {
      proofRun: false,
      verified: false,
      reason: owner ? "Set ALCHEMY_API_KEY to verify this owner through Alchemy." : "Asset has no owner address.",
    }

  console.log(JSON.stringify({
    asset: {
      assetId,
      title: asset.title ?? null,
      collection: asset.collection ?? null,
      chain: registry.chainNamespace,
      contractAddress: registry.contractAddress,
      tokenId: asset.token_id ?? null,
      owner,
      ownerUsername: asset.owner?.username ?? null,
      attributes: asset.attributes ?? [],
      facts,
    },
    recommendedGate: {
      description: "Broad gate derived from stable Courtyard facets.",
      rule: buildGateRule({ registry, minQuantity, match: recommendedMatch }),
    },
    specificGate: {
      description: "Narrower gate that keeps more of this asset's exact metadata.",
      rule: buildGateRule({ registry, minQuantity, match: specificMatch }),
    },
    alchemyProof: proof,
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
