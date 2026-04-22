import { COURTYARD_REGISTRIES } from "../src/lib/communities/courtyard-registry-config"
import {
  normalizeAssetMatch,
  normalizeInventoryMetadata,
  type Erc721InventoryAssetMatch,
  type RawInventoryAttribute,
} from "../src/lib/communities/community-token-inventory-gates"
import { normalizeEthereumAddress } from "../src/lib/communities/community-token-gates"

type ClubId = "rolex" | "gengar" | "charizard"
type NamespaceFamily = "hns" | "spaces"
type SupportedChain = "ethereum" | "polygon"

type ClubDefinition = {
  id: ClubId
  displayName: string
  description: string
  namespaceFamily: NamespaceFamily
  namespaceRootLabel: string
  namespaceDisplayLabel: string
  assetUrl: string
  matchMode: "watch_brand" | "pokemon_subject"
}

type CourtyardIndexedAsset = {
  attributes?: RawInventoryAttribute[]
  chain?: string
  collection?: string
  contract?: string
  owner?: { address?: string; username?: string; user_id?: string }
  title?: string
  token_id?: string
}

type GateRuleInput = {
  scope: "membership"
  gate_family: "identity_proof" | "token_holding"
  gate_type: "wallet_score" | "erc721_inventory_match"
  proof_requirements?: Array<{
    proof_type: "wallet_score"
    accepted_providers: ["passport"]
    config: { minimum_score: number }
  }>
  chain_namespace?: string | null
  gate_config?: Record<string, unknown> | null
}

type CreateCommunityPayload = {
  display_name: string
  description: string
  governance_mode: "centralized"
  membership_mode: "gated"
  default_age_gate_policy: "none"
  allow_anonymous_identity: false
  human_verification_lane: "self"
  handle_policy: { policy_template: "standard" }
  namespace?: { namespace_verification_id: string }
  gate_rules: GateRuleInput[]
}

const PASSPORT_MINIMUM_SCORE = 20

const CLUBS: ClubDefinition[] = [
  {
    id: "rolex",
    displayName: "@rolex",
    description: "A club for people with a Rolex collectible on Courtyard.",
    namespaceFamily: "spaces",
    namespaceRootLabel: "@rolex",
    namespaceDisplayLabel: "@rolex",
    assetUrl: "https://courtyard.io/asset/993ffcc672a304a1e7ab33aa222fda9b2c7716b0aa7c77e3211f0c903c98f6ef",
    matchMode: "watch_brand",
  },
  {
    id: "gengar",
    displayName: ".gengar",
    description: "A club for people with a Gengar Pokemon card on Courtyard.",
    namespaceFamily: "hns",
    namespaceRootLabel: "gengar",
    namespaceDisplayLabel: ".gengar",
    assetUrl: "https://courtyard.io/asset/b89f44407d184dc025387018a7d6119431e5db9668699b9a20a3acdf2b8237a9",
    matchMode: "pokemon_subject",
  },
  {
    id: "charizard",
    displayName: ".charizard",
    description: "A club for people with a Charizard Pokemon card on Courtyard.",
    namespaceFamily: "hns",
    namespaceRootLabel: "charizard",
    namespaceDisplayLabel: ".charizard",
    assetUrl: "https://courtyard.io/asset/2e5f78716147eb3d9367ae4bd439eddcbbeec8c63f77ec9c7bc229ea61e2f563",
    matchMode: "pokemon_subject",
  },
]

function readArg(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1] ?? null
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name)
}

function extractAssetId(value: string): string {
  const match = value.trim().match(/(?:\/asset\/)?([a-fA-F0-9]{64})(?:[/?#].*)?$/u)
  if (!match?.[1]) {
    throw new Error(`Invalid Courtyard asset URL: ${value}`)
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

function requireCourtyardRegistry(input: {
  chain: SupportedChain
  contractAddress: string | undefined
}): (typeof COURTYARD_REGISTRIES)[number] {
  const chainNamespace = chainNamespaceFor(input.chain)
  const contractAddress = normalizeEthereumAddress(input.contractAddress)
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
    headers: { "user-agent": "Mozilla/5.0 Pirate admin club seed" },
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

async function fetchCourtyardAsset(assetUrl: string): Promise<CourtyardIndexedAsset> {
  const apiUrl = await readCourtyardApiUrl()
  const response = await fetch(new URL(`/index/asset/${extractAssetId(assetUrl)}`, apiUrl), {
    headers: { "user-agent": "Mozilla/5.0 Pirate admin club seed" },
  })
  if (!response.ok) {
    throw new Error(`Courtyard asset lookup failed with ${response.status}`)
  }
  return response.json() as Promise<CourtyardIndexedAsset>
}

function normalizeCourtyardAsset(asset: CourtyardIndexedAsset): ReturnType<typeof normalizeInventoryMetadata> {
  return normalizeInventoryMetadata({
    attributes: asset.attributes,
    collection: asset.collection,
    title: asset.title,
    name: asset.title,
  })
}

function pokemonCreatureSubject(subject: string | null): string | null {
  if (!subject) return null
  const normalized = subject.replace(/^.+?'s\s+/u, "").trim().toLowerCase()
  return normalized || null
}

function buildClubMatch(definition: ClubDefinition, asset: CourtyardIndexedAsset): Erc721InventoryAssetMatch {
  const facts = normalizeCourtyardAsset(asset)
  const match = definition.matchMode === "watch_brand"
    ? normalizeAssetMatch({
      category: "watch",
      brand: facts.brand ?? undefined,
    })
    : normalizeAssetMatch({
      category: "trading_card",
      franchise: facts.franchise ?? undefined,
      subject: pokemonCreatureSubject(facts.subject) ?? facts.subject ?? undefined,
    })
  if (!match) {
    throw new Error(`Could not derive a valid inventory match for ${definition.id}`)
  }
  return match
}

function buildPassportGate(): GateRuleInput {
  return {
    scope: "membership",
    gate_family: "identity_proof",
    gate_type: "wallet_score",
    proof_requirements: [
      {
        proof_type: "wallet_score",
        accepted_providers: ["passport"],
        config: { minimum_score: PASSPORT_MINIMUM_SCORE },
      },
    ],
  }
}

function buildInventoryGate(input: {
  registry: (typeof COURTYARD_REGISTRIES)[number]
  match: Erc721InventoryAssetMatch
}): GateRuleInput {
  return {
    scope: "membership",
    gate_family: "token_holding",
    gate_type: "erc721_inventory_match",
    chain_namespace: input.registry.chainNamespace,
    proof_requirements: [],
    gate_config: {
      contract_address: input.registry.contractAddress,
      inventory_provider: "courtyard",
      min_quantity: 1,
      match: input.match,
    },
  }
}

function readNamespaceVerificationId(id: ClubId): string | null {
  const arg = readArg(`--${id}-namespace-verification-id`)
  const envName = `PIRATE_${id.toUpperCase()}_NAMESPACE_VERIFICATION_ID`
  return arg?.trim() || String(process.env[envName] ?? "").trim() || null
}

function buildCreatePayload(input: {
  definition: ClubDefinition
  namespaceVerificationId: string | null
  inventoryGate: GateRuleInput
}): CreateCommunityPayload {
  return {
    display_name: input.definition.displayName,
    description: input.definition.description,
    governance_mode: "centralized",
    membership_mode: "gated",
    default_age_gate_policy: "none",
    allow_anonymous_identity: false,
    human_verification_lane: "self",
    handle_policy: { policy_template: "standard" },
    ...(input.namespaceVerificationId
      ? { namespace: { namespace_verification_id: input.namespaceVerificationId } }
      : {}),
    gate_rules: [
      buildPassportGate(),
      input.inventoryGate,
    ],
  }
}

async function postCommunity(input: {
  apiUrl: string
  authToken: string
  payload: CreateCommunityPayload
}): Promise<Record<string, unknown>> {
  const response = await fetch(new URL("/communities", input.apiUrl), {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.authToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(input.payload),
  })
  const body = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok) {
    return {
      created: false,
      status: response.status,
      response: body,
    }
  }
  return {
    created: true,
    status: response.status,
    response: body,
  }
}

async function main(): Promise<void> {
  const execute = hasFlag("--execute")
  const apiUrl = readArg("--api-url") ?? process.env.PIRATE_API_URL ?? "http://localhost:8787"
  const authToken = readArg("--auth-token") ?? process.env.PIRATE_ADMIN_AUTH_TOKEN ?? ""
  if (execute && !authToken.trim()) {
    throw new Error("--execute requires --auth-token or PIRATE_ADMIN_AUTH_TOKEN")
  }

  const clubs = []
  for (const definition of CLUBS) {
    const asset = await fetchCourtyardAsset(definition.assetUrl)
    const chain = chainFromCourtyardAsset(asset)
    const registry = requireCourtyardRegistry({ chain, contractAddress: asset.contract })
    const match = buildClubMatch(definition, asset)
    const inventoryGate = buildInventoryGate({ registry, match })
    const namespaceVerificationId = readNamespaceVerificationId(definition.id)
    const createPayload = buildCreatePayload({
      definition,
      namespaceVerificationId,
      inventoryGate,
    })
    if (execute && !namespaceVerificationId) {
      throw new Error(`--execute requires --${definition.id}-namespace-verification-id`)
    }
    const createResult = execute
      ? await postCommunity({ apiUrl, authToken, payload: createPayload })
      : null

    clubs.push({
      id: definition.id,
      displayName: definition.displayName,
      namespace: {
        family: definition.namespaceFamily,
        root_label: definition.namespaceRootLabel,
        display_label: definition.namespaceDisplayLabel,
        namespace_verification_id: namespaceVerificationId,
        verificationStartRequest: namespaceVerificationId
          ? null
          : {
            method: "POST",
            path: "/namespace-verification-sessions",
            body: {
              family: definition.namespaceFamily,
              root_label: definition.namespaceRootLabel,
            },
          },
      },
      asset: {
        url: definition.assetUrl,
        title: asset.title ?? null,
        chain: registry.chainNamespace,
        contractAddress: registry.contractAddress,
        tokenId: asset.token_id ?? null,
        facts: normalizeCourtyardAsset(asset),
      },
      gates: {
        passportMinimumScore: PASSPORT_MINIMUM_SCORE,
        inventoryMatch: match,
      },
      createPayload,
      createResult,
    })
  }

  console.log(JSON.stringify({
    mode: execute ? "execute" : "dry_run",
    apiUrl: execute ? apiUrl : null,
    clubs,
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
