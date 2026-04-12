import type {
  CommunityMoneyPolicy,
  CommunityPurchaseQuotePreflight,
  CommunityPurchaseQuotePreflightRequest,
  Env,
  UpdateCommunityMoneyPolicyRequest,
} from "../../types"
import type { CommunityMoneyPolicyRow, CommunityRow } from "../auth/control-plane-auth-rows"
import type { CommunityRepository } from "./control-plane-community-repository"
import { badRequestError, eligibilityFailed, notFoundError } from "../errors"
import { verifyPirateAccessToken } from "../auth/pirate-session-token"
import { nowIso } from "../helpers"
import { assertNonEmptyString, assertNullableString, isRecord } from "../validation"

type MoneyAssetRef = CommunityMoneyPolicy["accepted_funding_assets"][number]
type MoneyChainRef = CommunityMoneyPolicy["accepted_source_chains"][number]

export type CommunityFundingQuotePreflightInput = {
  communityId: string
  repository: CommunityRepository
  fundingAsset: {
    assetSymbol: string
    chainNamespace?: string | null
    chainId?: number | null
  } | null
  sourceChain: {
    chainNamespace: string
    chainId?: number | null
  } | null
  routeProvider?: string | null
  destinationSettlementChain: {
    chainNamespace: string
    chainId?: number | null
  }
  destinationSettlementToken: string
  estimatedSlippageBps: number
  estimatedHopCount: number
  routeValidForSeconds?: number | null
}

type CommunityFundingQuoteEligibilityInput = Omit<CommunityFundingQuotePreflightInput, "communityId" | "repository">

function assertMoneyAssetRef(value: unknown, fieldName: string): asserts value is MoneyAssetRef {
  if (!isRecord(value)) {
    throw badRequestError(`${fieldName} must be an object`)
  }
  assertNonEmptyString(value.asset_symbol, `${fieldName}.asset_symbol`)
  assertNullableString(value.chain_namespace, `${fieldName}.chain_namespace`)
  if (value.chain_id != null && (!Number.isInteger(value.chain_id) || Number(value.chain_id) < 0)) {
    throw badRequestError(`${fieldName}.chain_id must be a non-negative integer or null`)
  }
  assertNullableString(value.display_name, `${fieldName}.display_name`)
}

function assertMoneyChainRef(value: unknown, fieldName: string): asserts value is MoneyChainRef {
  if (!isRecord(value)) {
    throw badRequestError(`${fieldName} must be an object`)
  }
  assertNonEmptyString(value.chain_namespace, `${fieldName}.chain_namespace`)
  if (value.chain_id != null && (!Number.isInteger(value.chain_id) || Number(value.chain_id) < 0)) {
    throw badRequestError(`${fieldName}.chain_id must be a non-negative integer or null`)
  }
  assertNullableString(value.display_name, `${fieldName}.display_name`)
}

function parseJsonArray<T>(value: string, fieldName: string): T[] {
  const parsed = JSON.parse(value) as unknown
  if (!Array.isArray(parsed)) {
    throw badRequestError(`${fieldName} stored value is invalid`)
  }
  return parsed as T[]
}

function parseJsonObject<T>(value: string, fieldName: string): T {
  const parsed = JSON.parse(value) as unknown
  if (!isRecord(parsed)) {
    throw badRequestError(`${fieldName} stored value is invalid`)
  }
  return parsed as T
}

function resolveDefaultCommunityMoneyPolicy(community: CommunityRow): CommunityMoneyPolicy {
  return {
    community_id: community.community_id,
    policy_origin: "default",
    funding_preference: "USD",
    accepted_funding_assets: [],
    accepted_source_chains: [],
    approved_route_providers: null,
    destination_settlement_chain: {
      chain_namespace: "eip155",
      chain_id: null,
      display_name: "Story",
    },
    destination_settlement_token: "WIP",
    treasury_denomination: "WIP",
    max_slippage_bps: 0,
    quote_ttl_seconds: 300,
    route_required: false,
    route_status_policy: "fail",
    route_hop_tolerance: 0,
    updated_at: community.updated_at,
  }
}

function serializeCommunityMoneyPolicy(
  community: CommunityRow,
  row: CommunityMoneyPolicyRow | null,
): CommunityMoneyPolicy {
  if (!row) {
    return resolveDefaultCommunityMoneyPolicy(community)
  }

  return {
    community_id: community.community_id,
    policy_origin: "explicit",
    funding_preference: row.funding_preference,
    accepted_funding_assets: parseJsonArray<MoneyAssetRef>(row.accepted_funding_assets_json, "accepted_funding_assets"),
    accepted_source_chains: parseJsonArray<MoneyChainRef>(row.accepted_source_chains_json, "accepted_source_chains"),
    approved_route_providers: row.approved_route_providers_json == null
      ? null
      : parseJsonArray<string>(row.approved_route_providers_json, "approved_route_providers"),
    destination_settlement_chain: parseJsonObject<MoneyChainRef>(
      row.destination_settlement_chain_json,
      "destination_settlement_chain",
    ),
    destination_settlement_token: row.destination_settlement_token,
    treasury_denomination: row.treasury_denomination,
    max_slippage_bps: row.max_slippage_bps,
    quote_ttl_seconds: row.quote_ttl_seconds,
    route_required: row.route_required === 1,
    route_status_policy: row.route_status_policy,
    route_hop_tolerance: row.route_hop_tolerance,
    updated_at: row.updated_at,
  }
}

function chainMatchesPolicy(policyChain: MoneyChainRef, inputChain: { chainNamespace: string; chainId?: number | null }): boolean {
  if (policyChain.chain_namespace !== inputChain.chainNamespace) {
    return false
  }

  if (policyChain.chain_id == null) {
    return true
  }

  return policyChain.chain_id === (inputChain.chainId ?? null)
}

function assetMatchesPolicy(
  policyAsset: MoneyAssetRef,
  inputAsset: { assetSymbol: string; chainNamespace?: string | null; chainId?: number | null },
): boolean {
  if (policyAsset.asset_symbol !== inputAsset.assetSymbol) {
    return false
  }

  if (policyAsset.chain_namespace != null && policyAsset.chain_namespace !== (inputAsset.chainNamespace ?? null)) {
    return false
  }

  if (policyAsset.chain_id != null && policyAsset.chain_id !== (inputAsset.chainId ?? null)) {
    return false
  }

  return true
}

function assertCommunityMoneyPolicyRequest(value: unknown): asserts value is UpdateCommunityMoneyPolicyRequest {
  if (!isRecord(value)) {
    throw badRequestError("Invalid community money policy payload")
  }

  assertNonEmptyString(value.funding_preference, "funding_preference")
  if (!Array.isArray(value.accepted_funding_assets)) {
    throw badRequestError("accepted_funding_assets must be an array")
  }
  if (!Array.isArray(value.accepted_source_chains)) {
    throw badRequestError("accepted_source_chains must be an array")
  }
  value.accepted_funding_assets.forEach((asset, index) => {
    assertMoneyAssetRef(asset, `accepted_funding_assets[${index}]`)
  })
  value.accepted_source_chains.forEach((chain, index) => {
    assertMoneyChainRef(chain, `accepted_source_chains[${index}]`)
  })

  assertMoneyChainRef(value.destination_settlement_chain, "destination_settlement_chain")
  assertNonEmptyString(value.destination_settlement_token, "destination_settlement_token")
  assertNullableString(value.treasury_denomination, "treasury_denomination")

  if (!Number.isInteger(value.max_slippage_bps) || Number(value.max_slippage_bps) < 0) {
    throw badRequestError("max_slippage_bps must be a non-negative integer")
  }
  if (!Number.isInteger(value.quote_ttl_seconds) || Number(value.quote_ttl_seconds) < 1) {
    throw badRequestError("quote_ttl_seconds must be a positive integer")
  }
  if (typeof value.route_required !== "boolean") {
    throw badRequestError("route_required must be a boolean")
  }
  if (
    value.route_status_policy !== "fail"
    && value.route_status_policy !== "fallback_display"
    && value.route_status_policy !== "queue"
  ) {
    throw badRequestError("route_status_policy is invalid")
  }
  if (!Number.isInteger(value.route_hop_tolerance) || Number(value.route_hop_tolerance) < 0) {
    throw badRequestError("route_hop_tolerance must be a non-negative integer")
  }

  if (value.approved_route_providers != null) {
    if (!Array.isArray(value.approved_route_providers)) {
      throw badRequestError("approved_route_providers must be an array or null")
    }
    value.approved_route_providers.forEach((provider, index) => {
      assertNonEmptyString(provider, `approved_route_providers[${index}]`)
    })
  }

  if (value.route_required) {
    if (value.accepted_funding_assets.length === 0) {
      throw eligibilityFailed("route_required communities must define at least one accepted funding asset")
    }
    if (value.accepted_source_chains.length === 0) {
      throw eligibilityFailed("route_required communities must define at least one accepted source chain")
    }
    if ((value.approved_route_providers?.length ?? 0) === 0) {
      throw eligibilityFailed("route_required communities must define at least one approved route provider")
    }
  }
}

function assertCommunityPurchaseQuotePreflightRequest(
  value: unknown,
): asserts value is CommunityPurchaseQuotePreflightRequest {
  if (!isRecord(value)) {
    throw badRequestError("Invalid community purchase quote preflight payload")
  }

  if (value.funding_asset !== undefined && value.funding_asset !== null) {
    assertMoneyAssetRef(value.funding_asset, "funding_asset")
  }
  if (value.source_chain !== undefined && value.source_chain !== null) {
    assertMoneyChainRef(value.source_chain, "source_chain")
  }
  assertNullableString(value.route_provider, "route_provider")

  if (!Number.isInteger(value.client_estimated_slippage_bps) || Number(value.client_estimated_slippage_bps) < 0) {
    throw badRequestError("client_estimated_slippage_bps must be a non-negative integer")
  }
  if (
    !Number.isInteger(value.client_estimated_hop_count) || Number(value.client_estimated_hop_count) < 0
  ) {
    throw badRequestError("client_estimated_hop_count must be a non-negative integer")
  }
  if (
    value.client_route_valid_for_seconds != null
    && (!Number.isInteger(value.client_route_valid_for_seconds) || Number(value.client_route_valid_for_seconds) < 0)
  ) {
    throw badRequestError("client_route_valid_for_seconds must be a non-negative integer or null")
  }
}

async function requireCommunity(repo: CommunityRepository, communityId: string): Promise<CommunityRow> {
  const community = await repo.getCommunityById(communityId)
  if (!community) {
    throw notFoundError("Community not found")
  }
  return community
}

export async function resolveCommunityMoneyPolicy(input: {
  repository: CommunityRepository
  communityId: string
}): Promise<CommunityMoneyPolicy> {
  const community = await requireCommunity(input.repository, input.communityId)
  const row = await input.repository.getCommunityMoneyPolicyByCommunityId(input.communityId)
  return serializeCommunityMoneyPolicy(community, row)
}

export async function getCommunityMoneyPolicy(input: {
  env: Env
  bearerToken: string
  communityId: string
  repository: CommunityRepository
}): Promise<CommunityMoneyPolicy> {
  await verifyPirateAccessToken({
    token: input.bearerToken,
    env: input.env,
  })
  return resolveCommunityMoneyPolicy({
    repository: input.repository,
    communityId: input.communityId,
  })
}

export async function updateCommunityMoneyPolicy(input: {
  env: Env
  bearerToken: string
  communityId: string
  body: unknown
  repository: CommunityRepository
}): Promise<CommunityMoneyPolicy> {
  const session = await verifyPirateAccessToken({
    token: input.bearerToken,
    env: input.env,
  })
  assertCommunityMoneyPolicyRequest(input.body)
  const community = await requireCommunity(input.repository, input.communityId)
  if (community.creator_user_id !== session.userId) {
    throw notFoundError("Community not found")
  }

  const updatedAt = nowIso()
  await input.repository.upsertCommunityMoneyPolicy({
    communityId: input.communityId,
    fundingPreference: input.body.funding_preference,
    acceptedFundingAssetsJson: JSON.stringify(input.body.accepted_funding_assets),
    acceptedSourceChainsJson: JSON.stringify(input.body.accepted_source_chains),
    approvedRouteProvidersJson: input.body.approved_route_providers == null
      ? null
      : JSON.stringify(input.body.approved_route_providers),
    destinationSettlementChainJson: JSON.stringify(input.body.destination_settlement_chain),
    destinationSettlementToken: input.body.destination_settlement_token,
    treasuryDenomination: input.body.treasury_denomination ?? null,
    maxSlippageBps: input.body.max_slippage_bps,
    quoteTtlSeconds: input.body.quote_ttl_seconds,
    routeRequired: input.body.route_required,
    routeStatusPolicy: input.body.route_status_policy,
    routeHopTolerance: input.body.route_hop_tolerance,
    updatedAt,
  })

  const row = await input.repository.getCommunityMoneyPolicyByCommunityId(input.communityId)
  if (!row) {
    throw notFoundError("Community money policy not found")
  }
  return serializeCommunityMoneyPolicy(community, row)
}

function assertCommunityFundingQuoteEligibleAgainstPolicy(
  policy: CommunityMoneyPolicy,
  input: CommunityFundingQuoteEligibilityInput,
): CommunityMoneyPolicy {
  if (!Number.isInteger(input.estimatedSlippageBps) || input.estimatedSlippageBps < 0) {
    throw badRequestError("estimatedSlippageBps must be a non-negative integer")
  }
  if (!Number.isInteger(input.estimatedHopCount) || input.estimatedHopCount < 0) {
    throw badRequestError("estimatedHopCount must be a non-negative integer")
  }
  if (
    input.routeValidForSeconds != null
    && (!Number.isInteger(input.routeValidForSeconds) || input.routeValidForSeconds < 0)
  ) {
    throw badRequestError("routeValidForSeconds must be a non-negative integer or null")
  }

  if (!chainMatchesPolicy(policy.destination_settlement_chain, input.destinationSettlementChain)) {
    throw eligibilityFailed("Destination settlement chain does not satisfy community policy")
  }

  if (policy.destination_settlement_token !== input.destinationSettlementToken) {
    throw eligibilityFailed("Destination settlement token does not satisfy community policy")
  }

  if (input.estimatedSlippageBps > policy.max_slippage_bps) {
    throw eligibilityFailed("Route slippage exceeds community policy")
  }

  if (input.estimatedHopCount > policy.route_hop_tolerance) {
    throw eligibilityFailed("Route hop count exceeds community policy")
  }

  if (
    input.routeValidForSeconds != null
    && input.routeValidForSeconds < policy.quote_ttl_seconds
  ) {
    throw eligibilityFailed("Route validity window is shorter than the community minimum quote TTL")
  }

  const routeRequested = input.routeProvider != null || input.fundingAsset != null || input.sourceChain != null

  if (!policy.route_required && !routeRequested) {
    return policy
  }

  if (policy.route_required && !input.routeProvider) {
    throw eligibilityFailed("An approved funding route is required for this community")
  }

  if (!input.fundingAsset) {
    throw eligibilityFailed("Funding asset is required for routed funding")
  }

  if (!input.sourceChain) {
    throw eligibilityFailed("Funding source chain is required for routed funding")
  }

  const fundingAsset = input.fundingAsset
  const sourceChain = input.sourceChain

  if (
    policy.approved_route_providers != null
    && input.routeProvider != null
    && !policy.approved_route_providers.includes(input.routeProvider)
  ) {
    throw eligibilityFailed("Route provider is not approved for this community")
  }

  if (!policy.accepted_funding_assets.some((asset) => assetMatchesPolicy(asset, fundingAsset))) {
    throw eligibilityFailed("Funding asset is not accepted for this community")
  }

  if (!policy.accepted_source_chains.some((chain) => chainMatchesPolicy(chain, sourceChain))) {
    throw eligibilityFailed("Funding source chain is not accepted for this community")
  }

  return policy
}

export async function assertCommunityFundingQuoteEligible(
  input: CommunityFundingQuotePreflightInput,
): Promise<CommunityMoneyPolicy> {
  const policy = await resolveCommunityMoneyPolicy({
    repository: input.repository,
    communityId: input.communityId,
  })

  return assertCommunityFundingQuoteEligibleAgainstPolicy(policy, {
    fundingAsset: input.fundingAsset,
    sourceChain: input.sourceChain,
    routeProvider: input.routeProvider,
    destinationSettlementChain: input.destinationSettlementChain,
    destinationSettlementToken: input.destinationSettlementToken,
    estimatedSlippageBps: input.estimatedSlippageBps,
    estimatedHopCount: input.estimatedHopCount,
    routeValidForSeconds: input.routeValidForSeconds,
  })
}

export async function quoteCommunityPurchasePreflight(input: {
  env: Env
  bearerToken: string
  communityId: string
  body: unknown
  repository: CommunityRepository
}): Promise<CommunityPurchaseQuotePreflight> {
  await verifyPirateAccessToken({
    token: input.bearerToken,
    env: input.env,
  })
  assertCommunityPurchaseQuotePreflightRequest(input.body)

  const policy = await resolveCommunityMoneyPolicy({
    repository: input.repository,
    communityId: input.communityId,
  })

  const eligiblePolicy = assertCommunityFundingQuoteEligibleAgainstPolicy(policy, {
    fundingAsset: input.body.funding_asset == null
      ? null
      : {
          assetSymbol: input.body.funding_asset.asset_symbol,
          chainNamespace: input.body.funding_asset.chain_namespace ?? null,
          chainId: input.body.funding_asset.chain_id ?? null,
        },
    sourceChain: input.body.source_chain == null
      ? null
      : {
          chainNamespace: input.body.source_chain.chain_namespace,
          chainId: input.body.source_chain.chain_id ?? null,
        },
    routeProvider: input.body.route_provider ?? null,
    destinationSettlementChain: {
      chainNamespace: policy.destination_settlement_chain.chain_namespace,
      chainId: policy.destination_settlement_chain.chain_id ?? null,
    },
    destinationSettlementToken: policy.destination_settlement_token,
    estimatedSlippageBps: input.body.client_estimated_slippage_bps,
    estimatedHopCount: input.body.client_estimated_hop_count,
    routeValidForSeconds: input.body.client_route_valid_for_seconds ?? null,
  })

  const routeRequested = (
    input.body.route_provider != null
    || input.body.funding_asset != null
    || input.body.source_chain != null
  )
  const quotedAt = nowIso()
  const expiresAt = new Date(Date.parse(quotedAt) + eligiblePolicy.quote_ttl_seconds * 1000).toISOString()

  return {
    community_id: eligiblePolicy.community_id,
    eligible: true,
    funding_mode: routeRequested ? "routed" : "direct",
    policy_origin: eligiblePolicy.policy_origin,
    funding_preference: eligiblePolicy.funding_preference,
    funding_asset: input.body.funding_asset ?? null,
    source_chain: input.body.source_chain ?? null,
    route_provider: input.body.route_provider ?? null,
    destination_settlement_chain: eligiblePolicy.destination_settlement_chain,
    destination_settlement_token: eligiblePolicy.destination_settlement_token,
    treasury_denomination: eligiblePolicy.treasury_denomination ?? null,
    max_slippage_bps: eligiblePolicy.max_slippage_bps,
    quote_ttl_seconds: eligiblePolicy.quote_ttl_seconds,
    route_required: eligiblePolicy.route_required,
    route_status_policy: eligiblePolicy.route_status_policy,
    route_hop_tolerance: eligiblePolicy.route_hop_tolerance,
    quoted_at: quotedAt,
    expires_at: expiresAt,
  }
}
