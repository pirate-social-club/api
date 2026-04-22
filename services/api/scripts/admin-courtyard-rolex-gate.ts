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

type MatchedNft = {
  tokenId: string | null
  name: string | null
  collection: string | null
  facts: ReturnType<typeof normalizeInventoryMetadata>
}

function requirePolygonCourtyardRegistry(): (typeof COURTYARD_REGISTRIES)[number] {
  const value = COURTYARD_REGISTRIES.find((entry) => entry.chainNamespace === "eip155:137")
  if (!value) {
    throw new Error("Missing Courtyard Polygon registry config")
  }
  return value
}

const registry = requirePolygonCourtyardRegistry()

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

function buildGateRule(minQuantity: number): Record<string, unknown> {
  return {
    scope: "membership",
    gate_family: "token_holding",
    gate_type: "erc721_inventory_match",
    chain_namespace: registry.chainNamespace,
    proof_requirements: [],
    gate_config: {
      contract_address: registry.contractAddress,
      inventory_provider: "courtyard",
      min_quantity: minQuantity,
      match: ROLEX_MATCH,
    },
  }
}

function buildGatesPatchBody(minQuantity: number): Record<string, unknown> {
  return {
    membership_mode: "gated",
    default_age_gate_policy: "none",
    allow_anonymous_identity: false,
    anonymous_identity_scope: null,
    gate_rules: [buildGateRule(minQuantity)],
  }
}

function buildAlchemyUrl(input: {
  apiKey: string
  owner: string
  pageKey: string | null
}): URL {
  const url = new URL(`https://polygon-mainnet.g.alchemy.com/nft/v3/${input.apiKey}/getNFTsForOwner`)
  url.searchParams.set("owner", input.owner)
  url.searchParams.append("contractAddresses[]", registry.contractAddress)
  url.searchParams.set("withMetadata", "true")
  url.searchParams.set("pageSize", "100")
  if (input.pageKey) {
    url.searchParams.set("pageKey", input.pageKey)
  }
  return url
}

async function fetchAlchemyPage(input: {
  apiKey: string
  owner: string
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
  owner: string
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
      owner: input.owner,
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
        owner: input.owner,
        contractAddress: registry.contractAddress,
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
    owner: input.owner,
    contractAddress: registry.contractAddress,
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

async function main(): Promise<void> {
  const owner = normalizeEthereumAddress(readArg("--owner") ?? readArg("--wallet"))
  const apiKey = String(process.env.ALCHEMY_API_KEY ?? "").trim()
  const communityId = readArg("--community-id")
  const minQuantity = readIntArg("--min-quantity", 1, { min: 1, max: 100 })
  const maxPages = readIntArg("--max-pages", 20, { min: 1, max: 100 })
  const proof = owner && apiKey
    ? await proveWithAlchemy({ apiKey, owner, minQuantity, maxPages })
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
    createGateRule: buildGateRule(minQuantity),
    updateGatesRequest: {
      method: "PUT",
      path: communityId ? `/communities/${communityId}/gates` : "/communities/{communityId}/gates",
      body: buildGatesPatchBody(minQuantity),
    },
    alchemyProof: proof,
    notes: [
      "This admin gate does not require the admin wallet to own a Rolex.",
      "Alchemy proof verifies a known wallet against Courtyard's Polygon registry metadata.",
      "Runtime entitlement still uses the backend inventory gate evaluator and fails closed on provider errors.",
    ],
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
