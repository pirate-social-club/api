import { StoryClient, WIP_TOKEN_ADDRESS, PILFlavor, royaltyPolicyLapAddress, aeneid, mainnet } from "@story-protocol/core-sdk"
import { createWalletClient, fallback, http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import type { Client } from "../sql-client"
import type { Env } from "../../env"
import type { Post, SongArtifactBundle } from "../../types"
import { nowIso } from "../helpers"
import { resolveStoryOperatorDirectSigner } from "./story-direct-signer"
import {
  resolveStoryChainId,
  resolveStoryRpcUrls,
  resolveStoryRuntimeSignerTargetBalanceWei,
} from "./story-runtime-config"
import { getAssetRow } from "../communities/commerce/queries"
import { decodePublicAssetId } from "../public-ids"
import { publishStoryJsonMetadata } from "./story-metadata-publisher"
import { assertStoryRuntimeSignerFunding } from "./story-runtime-funding"
import { resolveDirectTxGasPolicy, type DirectTxGasPolicy } from "../evm-direct-tx"

type StoryRoyaltyClient = Pick<Client, "execute">
type StoryRoyaltyRightsBasis = "none" | "original" | "derivative"
export type StoryLicensePreset = "non-commercial" | "commercial-use" | "commercial-remix"
type StoryRoyaltyAssetKind = "song_audio" | "video_file"

export type StoryRoyaltyRegistrationResult = {
  storyIpId: string
  storyIpNftContract: string
  storyIpNftTokenId: string
  ipRoyaltyVault: string | null
  storyLicenseTermsId: string | null
  storyLicenseTemplate: string | null
  storyRoyaltyPolicy: string
  storyDerivativeParentIpIds: string[] | null
  storyRevenueToken: string
  storyRoyaltyRegistrationStatus: "registered"
  storyDerivativeRegisteredAt: string | null
}

type StoryRoyaltyRegistrationTestResult =
  & Omit<StoryRoyaltyRegistrationResult, "ipRoyaltyVault">
  & { ipRoyaltyVault?: string | null }

type ResolvedDerivativeParent = {
  ipId: `0x${string}`
  licenseTermsId: bigint
}

type StoryLicenseClient = {
  registerPilTermsAndAttach: (request: unknown) => Promise<{ licenseTermsId?: bigint | number | string | null }>
}

type StoryIpAssetClient = {
  registerDerivativeIpAsset: (request: {
    nft: {
      type: "mint"
      spgNftContract: `0x${string}`
      recipient: `0x${string}`
      allowDuplicates?: boolean
    }
    derivData: {
      parentIpIds: `0x${string}`[]
      licenseTermsIds: bigint[]
    }
    ipMetadata: {
      ipMetadataURI: string
      ipMetadataHash: `0x${string}`
      nftMetadataURI: string
      nftMetadataHash: `0x${string}`
    }
  }) => Promise<{
    ipId?: `0x${string}`
    tokenId?: bigint | number | string
  }>
  registerIpAsset: (request: {
    nft: {
      type: "mint"
      spgNftContract: `0x${string}`
      recipient: `0x${string}`
      allowDuplicates?: boolean
    }
    licenseTermsData: Array<{
      terms: ReturnType<typeof resolvePilTermsForLicense>
      maxLicenseTokens?: bigint
    }>
    ipMetadata: {
      ipMetadataURI: string
      ipMetadataHash: `0x${string}`
      nftMetadataURI: string
      nftMetadataHash: `0x${string}`
    }
  }) => Promise<{
    ipId?: `0x${string}`
    tokenId?: bigint | number | string
    licenseTermsIds?: Array<bigint | number | string>
  }>
}

type StoryRoyaltySdkClient = {
  ipAsset: StoryIpAssetClient
  royalty?: {
    getRoyaltyVaultAddress: (ipId: `0x${string}`) => Promise<`0x${string}` | string>
  }
  license?: StoryLicenseClient
}

type JsonRpcPayload = {
  id?: unknown
  jsonrpc?: string
  method?: string
}

type JsonRpcResponsePayload = {
  id?: unknown
  jsonrpc?: string
  result?: unknown
}

let testRoyaltyRegistrar: ((input: {
  env: Env
  client: StoryRoyaltyClient
  communityId: string
  assetId: string
  creatorWalletAddress: string
  title: string | null
  rightsBasis: Post["rights_basis"]
  licensePreset: StoryLicensePreset | null
  commercialRevSharePct: number | null
  upstreamAssetRefs: string[] | null
  assetKind: StoryRoyaltyAssetKind
  bundle: SongArtifactBundle | null
  primaryContentHash: `0x${string}`
}) => Promise<StoryRoyaltyRegistrationTestResult | null>) | null = null

let testStoryRoyaltySdkClientFactory: ((input: {
  env: Env
  operatorPrivateKey: `0x${string}`
}) => StoryRoyaltySdkClient) | null = null

export function setStoryRoyaltyRegistrarForTests(
  registrar: ((input: {
    env: Env
    client: StoryRoyaltyClient
    communityId: string
    assetId: string
    creatorWalletAddress: string
    title: string | null
    rightsBasis: Post["rights_basis"]
    licensePreset: StoryLicensePreset | null
    commercialRevSharePct: number | null
    upstreamAssetRefs: string[] | null
    assetKind: StoryRoyaltyAssetKind
    bundle: SongArtifactBundle | null
    primaryContentHash: `0x${string}`
  }) => Promise<StoryRoyaltyRegistrationTestResult | null>) | null,
): void {
  testRoyaltyRegistrar = registrar
}

export function setStoryRoyaltySdkClientFactoryForTests(
  factory: ((input: {
    env: Env
    operatorPrivateKey: `0x${string}`
  }) => StoryRoyaltySdkClient) | null,
): void {
  testStoryRoyaltySdkClientFactory = factory
}

function createStoryRoyaltySdkClient(input: {
  env: Env
  operatorPrivateKey: `0x${string}`
}): StoryRoyaltySdkClient {
  if (testStoryRoyaltySdkClientFactory) {
    return testStoryRoyaltySdkClientFactory(input)
  }

  const gasPolicy = resolveStoryRoyaltyGasPolicy(input.env)
  const transport = fallback(resolveStoryRpcUrls(input.env).map((url) => cappedStoryRoyaltyHttp(url, gasPolicy)))
  const wallet = createWalletClient({
    account: privateKeyToAccount(input.operatorPrivateKey),
    chain: resolveStoryViemChain(input.env),
    transport,
  })
  const uncappedWriteContract = wallet.writeContract.bind(wallet)
  wallet.writeContract = async (request: unknown) => {
    return await uncappedWriteContract(capStoryRoyaltyWriteContractRequestForTests(request, gasPolicy) as never)
  }

  return StoryClient.newClient({
    wallet,
    transport,
    chainId: resolveStoryChainName(input.env),
  }) as StoryRoyaltySdkClient
}

function resolveStoryViemChain(env: Pick<Env, "STORY_CHAIN_ID">): typeof aeneid | typeof mainnet {
  return resolveStoryChainId(env) === 1514 ? mainnet : aeneid
}

function resolveStoryRoyaltyGasPolicy(
  env: Pick<
    Env,
    | "STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI"
    | "STORY_DIRECT_TX_MAX_PRIORITY_FEE_PER_GAS_WEI"
    | "STORY_DIRECT_TX_GAS_LIMIT_MAX"
    | "STORY_DIRECT_TX_GAS_ESTIMATE_BUFFER_BPS"
  >,
): DirectTxGasPolicy {
  const gasPolicy = resolveDirectTxGasPolicy({
    maxFeePerGasCapWeiRaw: env.STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI,
    maxPriorityFeePerGasCapWeiRaw: env.STORY_DIRECT_TX_MAX_PRIORITY_FEE_PER_GAS_WEI,
    gasLimitCapRaw: env.STORY_DIRECT_TX_GAS_LIMIT_MAX,
    gasEstimateBufferBpsRaw: env.STORY_DIRECT_TX_GAS_ESTIMATE_BUFFER_BPS,
    maxFeePerGasCapField: "STORY_DIRECT_TX_MAX_FEE_PER_GAS_WEI",
    maxPriorityFeePerGasCapField: "STORY_DIRECT_TX_MAX_PRIORITY_FEE_PER_GAS_WEI",
    gasLimitCapField: "STORY_DIRECT_TX_GAS_LIMIT_MAX",
    gasEstimateBufferBpsField: "STORY_DIRECT_TX_GAS_ESTIMATE_BUFFER_BPS",
  })
  if (!gasPolicy.ok) throw new Error(gasPolicy.error)
  return gasPolicy.value
}

// Matches the direct-tx path (evm-direct-tx.ts) so the SDK path is bounded identically.
const STORY_ROYALTY_GAS_LIMIT_PADDING = 15_000n

function cappedStoryRoyaltyHttp(url: string, gasPolicy: DirectTxGasPolicy) {
  return http(url, {
    fetchFn: async (input, init) => {
      const response = await fetch(input, init)
      return await capStoryRoyaltyRpcFeeResponseForTests(response, init?.body, gasPolicy)
    },
  })
}

export async function capStoryRoyaltyRpcFeeResponseForTests(
  response: Response,
  requestBody: BodyInit | null | undefined,
  gasPolicy: DirectTxGasPolicy,
): Promise<Response> {
  if (!response.ok || !requestBody) return response
  const requestPayload = parseJsonRpcPayload(requestBody)
  if (!requestPayload) return response

  const text = await response.text()
  if (!text) return new Response(text, response)
  let responsePayload: unknown
  try {
    responsePayload = JSON.parse(text) as unknown
  } catch {
    return new Response(text, response)
  }

  const capped = Array.isArray(requestPayload) && Array.isArray(responsePayload)
    ? responsePayload.map((entry, index) => capJsonRpcResponseResult(entry, requestPayload[index], gasPolicy))
    : capJsonRpcResponseResult(responsePayload, Array.isArray(requestPayload) ? null : requestPayload, gasPolicy)

  return new Response(JSON.stringify(capped), response)
}

function parseJsonRpcPayload(body: BodyInit): JsonRpcPayload | JsonRpcPayload[] | null {
  if (typeof body !== "string") return null
  try {
    const parsed = JSON.parse(body) as unknown
    if (Array.isArray(parsed)) return parsed.filter(isJsonRpcPayload)
    return isJsonRpcPayload(parsed) ? parsed : null
  } catch {
    return null
  }
}

function isJsonRpcPayload(value: unknown): value is JsonRpcPayload {
  return typeof value === "object" && value != null && "method" in value
}

function capJsonRpcResponseResult(
  responsePayload: unknown,
  requestPayload: JsonRpcPayload | null | undefined,
  gasPolicy: DirectTxGasPolicy,
): unknown {
  if (
    !requestPayload?.method ||
    typeof responsePayload !== "object" ||
    responsePayload == null ||
    !("result" in responsePayload)
  ) {
    return responsePayload
  }
  const payload = responsePayload as JsonRpcResponsePayload
  // Gas-limit enforcement (added on top of the ported fee caps): buffer the
  // estimate exactly like the direct-tx path, then reject when it exceeds the
  // policy cap so worst-case tx cost stays gasLimitCap * maxFeePerGasCap and the
  // funding preflight can bound it. Rejecting fails before the tx is sent, so no
  // gas is spent — parity with evm-direct-tx's direct_tx_gas_limit_exceeds_policy.
  if (requestPayload.method === "eth_estimateGas") {
    return enforceStoryRoyaltyGasEstimate(payload, gasPolicy)
  }
  return {
    ...payload,
    result: capStoryRoyaltyRpcResult(requestPayload.method, payload.result, gasPolicy),
  }
}

function enforceStoryRoyaltyGasEstimate(
  payload: JsonRpcResponsePayload,
  gasPolicy: DirectTxGasPolicy,
): unknown {
  const estimate = parseRpcQuantity(payload.result)
  if (estimate == null) return payload
  const gasLimit = (estimate * gasPolicy.gasEstimateBufferBps) / 10_000n + STORY_ROYALTY_GAS_LIMIT_PADDING
  if (gasLimit > gasPolicy.gasLimitCap) {
    return {
      id: payload.id,
      jsonrpc: payload.jsonrpc ?? "2.0",
      error: {
        code: -32000,
        message: `story_royalty_gas_limit_exceeds_policy:${gasLimit.toString()}:${gasPolicy.gasLimitCap.toString()}`,
      },
    }
  }
  return { ...payload, result: `0x${gasLimit.toString(16)}` }
}

function capStoryRoyaltyRpcResult(
  method: string,
  result: unknown,
  gasPolicy: DirectTxGasPolicy,
): unknown {
  if (method === "eth_maxPriorityFeePerGas") {
    return capRpcQuantity(result, gasPolicy.maxPriorityFeePerGasCapWei)
  }
  if (method === "eth_gasPrice") {
    return capRpcQuantity(result, gasPolicy.maxFeePerGasCapWei)
  }
  if (method === "eth_feeHistory") {
    return capFeeHistoryResult(result, gasPolicy)
  }
  return result
}

function capFeeHistoryResult(result: unknown, gasPolicy: DirectTxGasPolicy): unknown {
  if (typeof result !== "object" || result == null) return result
  const value = result as {
    baseFeePerGas?: unknown
    reward?: unknown
  }
  return {
    ...value,
    baseFeePerGas: Array.isArray(value.baseFeePerGas)
      ? value.baseFeePerGas.map((entry) => capRpcQuantity(entry, gasPolicy.maxFeePerGasCapWei))
      : value.baseFeePerGas,
    reward: Array.isArray(value.reward)
      ? value.reward.map((row) =>
        Array.isArray(row)
          ? row.map((entry) => capRpcQuantity(entry, gasPolicy.maxPriorityFeePerGasCapWei))
          : row
      )
      : value.reward,
  }
}

function capRpcQuantity(value: unknown, cap: bigint): unknown {
  const parsed = parseRpcQuantity(value)
  if (parsed == null || parsed <= cap) return value
  return `0x${cap.toString(16)}`
}

function parseRpcQuantity(value: unknown): bigint | null {
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (/^0x[0-9a-fA-F]+$/.test(trimmed)) return BigInt(trimmed)
  if (/^\d+$/.test(trimmed)) return BigInt(trimmed)
  return null
}

export function capStoryRoyaltyWriteContractRequestForTests(
  request: unknown,
  gasPolicy: DirectTxGasPolicy,
): unknown {
  if (typeof request !== "object" || request == null) return request
  const value = request as Record<string, unknown>
  return {
    ...value,
    gasPrice: undefined,
    gas: capStoryRoyaltyGasLimitField(value.gas, gasPolicy.gasLimitCap),
    maxFeePerGas: capBigintField(value.maxFeePerGas, gasPolicy.maxFeePerGasCapWei),
    maxPriorityFeePerGas: capBigintField(value.maxPriorityFeePerGas, gasPolicy.maxPriorityFeePerGasCapWei),
  }
}

function capBigintField(value: unknown, cap: bigint): bigint {
  if (typeof value === "bigint" && value > 0n && value < cap) return value
  return cap
}

// Enforce a caller-supplied gas limit the same way the estimate path does:
// pass through when under the cap, reject when over it (throwing before send, so
// no gas is burned on an under-gassed tx), and leave it undefined when absent so
// viem estimates via eth_estimateGas (which enforceStoryRoyaltyGasEstimate then
// buffers + caps). Never silently clamp a flat cap here — that would skip revert
// detection and burn gas on doomed txs.
function capStoryRoyaltyGasLimitField(value: unknown, cap: bigint): bigint | undefined {
  if (typeof value !== "bigint" || value <= 0n) return undefined
  if (value > cap) {
    throw new Error(`story_royalty_gas_limit_exceeds_policy:${value.toString()}:${cap.toString()}`)
  }
  return value
}

const STORY_REGISTRATION_MAX_ATTEMPTS = 3
const STORY_REGISTRATION_RETRY_BASE_DELAY_MS = 400

function collectStoryErrorMessages(error: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && !seen.has(current)) {
    seen.add(current)
    const obj = current as { message?: unknown; cause?: unknown }
    if (typeof obj.message === "string") parts.push(obj.message)
    else if (!(current instanceof Error)) parts.push(String(current))
    current = obj.cause
  }
  return parts.join(" | ")
}

// A tx hash or a post-broadcast viem error anywhere in the chain means a
// transaction may already be in flight; retrying the mint (allowDuplicates:true)
// could double-mint, so such errors are never retryable.
function storyErrorChainHasBroadcastTx(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && !seen.has(current)) {
    seen.add(current)
    const obj = current as { transactionHash?: unknown; name?: unknown; cause?: unknown }
    if (typeof obj.transactionHash === "string" && /^0x[0-9a-fA-F]{64}$/.test(obj.transactionHash)) {
      return true
    }
    if (
      obj.name === "TransactionExecutionError" ||
      obj.name === "WaitForTransactionReceiptTimeoutError" ||
      obj.name === "TransactionReceiptNotFoundError"
    ) {
      return true
    }
    current = obj.cause
  }
  return false
}

// Retry ONLY pre-broadcast transport/simulate failures (the observed
// `mintAndRegisterIpAndAttachPILTerms reverted ... RPC Request failed` is a viem
// RpcRequestError from the pre-write eth_call, so no tx was sent). Never retry
// deterministic failures (insufficient operator funds, gas-policy rejection) or
// anything that may have already broadcast a tx.
export function isRetryableStoryRegistrationError(error: unknown): boolean {
  const message = collectStoryErrorMessages(error)
  if (/exceeds the balance|insufficient funds|story_royalty_gas_limit_exceeds_policy|funding below floor|funding_below_floor/i.test(message)) {
    return false
  }
  if (storyErrorChainHasBroadcastTx(error)) return false
  return /RPC Request failed|HTTP request failed|fetch failed|Failed to fetch|timed out|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|\b(429|500|502|503|504)\b|rate.?limit|InternalRpcError|took too long|network error/i.test(message)
}

function delayMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function withStoryRegistrationRetry<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= STORY_REGISTRATION_MAX_ATTEMPTS; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (attempt >= STORY_REGISTRATION_MAX_ATTEMPTS || !isRetryableStoryRegistrationError(error)) {
        throw error
      }
      await delayMs(STORY_REGISTRATION_RETRY_BASE_DELAY_MS * attempt)
    }
  }
  throw lastError
}

function normalizeStoryRoyaltyRightsBasis(
  rightsBasis: Post["rights_basis"] | null | undefined,
): StoryRoyaltyRightsBasis | null {
  return rightsBasis === "none" || rightsBasis === "original" || rightsBasis === "derivative"
    ? rightsBasis
    : null
}

function resolveStoryRoyaltySpgNftContract(env: Pick<Env, "STORY_ROYALTY_SPG_NFT_CONTRACT">): `0x${string}` | null {
  const value = String(env.STORY_ROYALTY_SPG_NFT_CONTRACT || "").trim()
  return /^0x[a-fA-F0-9]{40}$/.test(value) ? value as `0x${string}` : null
}

function validateCommercialRevSharePct(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error("commercialRevSharePct must be an integer from 0 to 100")
  }
  return value
}

function requireOriginalLicensePreset(value: StoryLicensePreset | null): StoryLicensePreset {
  if (!value) {
    throw new Error("licensePreset is required for original Story registration")
  }
  return value
}

export function resolvePilTermsForLicense(input: {
  licensePreset: StoryLicensePreset
  commercialRevSharePct: number | null
  defaultMintingFee: bigint
  currency: `0x${string}`
  royaltyPolicy: `0x${string}`
}) {
  if (input.licensePreset === "non-commercial") {
    return PILFlavor.nonCommercialSocialRemixing()
  }
  if (input.licensePreset === "commercial-use") {
    return PILFlavor.commercialUse({
      defaultMintingFee: input.defaultMintingFee,
      currency: input.currency,
      royaltyPolicy: input.royaltyPolicy,
    })
  }
  return PILFlavor.commercialRemix({
    commercialRevShare: validateCommercialRevSharePct(input.commercialRevSharePct),
    defaultMintingFee: input.defaultMintingFee,
    currency: input.currency,
    royaltyPolicy: input.royaltyPolicy,
  })
}

export function isStoryRoyaltyRegistrationConfigured(
  env: Pick<Env, "STORY_ROYALTY_SPG_NFT_CONTRACT">,
): boolean {
  return Boolean(resolveStoryRoyaltySpgNftContract(env))
}

function resolveStoryRoyaltyDefaultMintingFee(
  env: Pick<Env, "STORY_ROYALTY_DEFAULT_MINTING_FEE_WEI">,
): bigint {
  const raw = String(env.STORY_ROYALTY_DEFAULT_MINTING_FEE_WEI || "").trim()
  if (!raw) return 0n
  if (!/^\d+$/.test(raw)) {
    throw new Error("STORY_ROYALTY_DEFAULT_MINTING_FEE_WEI missing/invalid")
  }
  return BigInt(raw)
}

function resolveStoryRoyaltyMaxLicenseTokens(
  env: Pick<Env, "STORY_ROYALTY_MAX_LICENSE_TOKENS">,
): bigint | undefined {
  const raw = String(env.STORY_ROYALTY_MAX_LICENSE_TOKENS || "").trim()
  if (!raw) return undefined
  if (!/^\d+$/.test(raw)) {
    throw new Error("STORY_ROYALTY_MAX_LICENSE_TOKENS missing/invalid")
  }
  return BigInt(raw)
}

function resolveStoryRoyaltyPolicyAddress(
  env: Pick<Env, "STORY_ROYALTY_POLICY_LAP_ADDRESS" | "STORY_CHAIN_ID">,
): `0x${string}` {
  const override = String(env.STORY_ROYALTY_POLICY_LAP_ADDRESS || "").trim()
  if (/^0x[a-fA-F0-9]{40}$/.test(override)) {
    return override as `0x${string}`
  }
  const chainId = resolveStoryChainId(env) === 1514 ? 1514 : 1315
  return royaltyPolicyLapAddress[chainId]
}

function resolveStoryChainName(env: Pick<Env, "STORY_CHAIN_ID">): "aeneid" | "mainnet" {
  return resolveStoryChainId(env) === 1514 ? "mainnet" : "aeneid"
}

function parseDirectStoryParentRef(ref: string): ResolvedDerivativeParent | null {
  const match = /^story:ip:(0x[a-fA-F0-9]{40})#licenseTermsId=(\d+)$/.exec(ref.trim())
  if (!match) return null
  return {
    ipId: match[1] as `0x${string}`,
    licenseTermsId: BigInt(match[2]),
  }
}

export async function resolveStoryRoyaltyDerivativeParents(input: {
  client: StoryRoyaltyClient
  communityId: string
  upstreamAssetRefs: string[] | null
}): Promise<ResolvedDerivativeParent[] | null> {
  const refs = (input.upstreamAssetRefs ?? []).map((value) => value.trim()).filter(Boolean)
  if (refs.length === 0) return null

  const resolved: ResolvedDerivativeParent[] = []
  for (const ref of refs) {
    const direct = parseDirectStoryParentRef(ref)
    if (direct) {
      resolved.push(direct)
      continue
    }

    const localAssetId = ref.startsWith("story:asset:") ? ref.slice("story:asset:".length) : ref
    const decodedAssetId = decodePublicAssetId(localAssetId)
    if (!decodedAssetId.startsWith("ast_")) {
      return null
    }
    const asset = await getAssetRow(input.client, input.communityId, decodedAssetId)
    if (!asset?.story_ip_id?.trim() || !asset.story_license_terms_id?.trim()) {
      return null
    }
    if (!/^\d+$/.test(asset.story_license_terms_id)) {
      return null
    }
    resolved.push({
      ipId: asset.story_ip_id as `0x${string}`,
      licenseTermsId: BigInt(asset.story_license_terms_id),
    })
  }

  return resolved.length > 0 ? resolved : null
}

async function buildStoryRoyaltyMetadata(input: {
  env: Env
  communityId: string
  assetId: string
  title: string | null
  rightsBasis: StoryRoyaltyRightsBasis
  assetKind: StoryRoyaltyAssetKind
  creatorWalletAddress: string
  bundle: SongArtifactBundle | null
  primaryContentHash: `0x${string}`
  derivativeParentIpIds: string[] | null
}): Promise<{
  ipMetadataUri: string
  ipMetadataHash: `0x${string}`
  nftMetadataUri: string
  nftMetadataHash: `0x${string}`
}> {
  const coverArtRef = input.bundle?.cover_art?.storage_ref?.trim() || null
  const ipPayload = {
    version: 1,
    kind: "pirate_story_ip_metadata",
    community_id: input.communityId,
    asset_id: input.assetId,
    asset_kind: input.assetKind,
    title: input.title,
    rights_basis: input.rightsBasis,
    creator_wallet_address: input.creatorWalletAddress,
    song_artifact_bundle_id: input.bundle?.id.replace(/^sab_/, "") ?? null,
    cover_art_ref: coverArtRef,
    primary_content_hash: input.primaryContentHash,
    derivative_parent_ip_ids: input.derivativeParentIpIds,
    created_at: nowIso(),
  }
  const nftPayload = {
    name: input.title?.trim() || `Pirate Asset ${input.assetId}`,
    description: input.rightsBasis === "derivative"
      ? "Derivative Story-native Pirate commerce asset"
      : "Original Story-native Pirate commerce asset",
    ...(coverArtRef ? { image: coverArtRef } : {}),
    external_url: `pirate://communities/${input.communityId}/assets/${input.assetId}`,
    attributes: [
      { trait_type: "asset_id", value: input.assetId },
      { trait_type: "rights_basis", value: input.rightsBasis ?? "none" },
    ],
  }

  const [ipPublished, nftPublished] = await Promise.all([
    publishStoryJsonMetadata({
      env: input.env,
      path: `story-assets/${input.communityId}/${input.assetId}/ip.json`,
      payload: ipPayload,
    }),
    publishStoryJsonMetadata({
      env: input.env,
      path: `story-assets/${input.communityId}/${input.assetId}/nft.json`,
      payload: nftPayload,
    }),
  ])

  return {
    ipMetadataUri: ipPublished.uri,
    ipMetadataHash: ipPublished.hash,
    nftMetadataUri: nftPublished.uri,
    nftMetadataHash: nftPublished.hash,
  }
}

export async function maybeRegisterStoryRoyaltyForAsset(input: {
  env: Env
  client: StoryRoyaltyClient
  communityId: string
  assetId: string
  creatorWalletAddress: string
  title: string | null
  rightsBasis: Post["rights_basis"]
  licensePreset: StoryLicensePreset | null
  commercialRevSharePct: number | null
  upstreamAssetRefs: string[] | null
  assetKind: StoryRoyaltyAssetKind
  bundle: SongArtifactBundle | null
  primaryContentHash: `0x${string}`
}): Promise<StoryRoyaltyRegistrationResult | null> {
  if (testRoyaltyRegistrar) {
    const result = await testRoyaltyRegistrar(input)
    return result ? { ...result, ipRoyaltyVault: result.ipRoyaltyVault ?? null } : null
  }

  const rightsBasis = normalizeStoryRoyaltyRightsBasis(input.rightsBasis)
  if (!rightsBasis) {
    return null
  }

  const spgNftContract = resolveStoryRoyaltySpgNftContract(input.env)
  if (!spgNftContract) {
    return null
  }

  const operator = resolveStoryOperatorDirectSigner(input.env)
  if (!operator.ok) {
    throw new Error(operator.error)
  }
  if (!operator.value) {
    return null
  }

  const derivativeParents = rightsBasis === "derivative"
    ? await resolveStoryRoyaltyDerivativeParents({
        client: input.client,
        communityId: input.communityId,
        upstreamAssetRefs: input.upstreamAssetRefs,
      })
    : null
  if (rightsBasis === "derivative" && !derivativeParents) {
    return null
  }

  const storyOperatorMinimumBalanceWei = resolveStoryRuntimeSignerTargetBalanceWei(input.env)
  await assertStoryRuntimeSignerFunding(input.env, [
    { name: "story-operator", minBalanceWei: storyOperatorMinimumBalanceWei },
  ])

  const metadata = await buildStoryRoyaltyMetadata({
    env: input.env,
    communityId: input.communityId,
    assetId: input.assetId,
    title: input.title,
    rightsBasis,
    assetKind: input.assetKind,
    creatorWalletAddress: input.creatorWalletAddress,
    bundle: input.bundle,
    primaryContentHash: input.primaryContentHash,
    derivativeParentIpIds: derivativeParents?.map((parent) => parent.ipId) ?? null,
  })

  const storyClient = createStoryRoyaltySdkClient({
    env: input.env,
    operatorPrivateKey: operator.value.privateKey as `0x${string}`,
  })

  const royaltyPolicy = resolveStoryRoyaltyPolicyAddress(input.env)
  const defaultMintingFee = resolveStoryRoyaltyDefaultMintingFee(input.env)
  const maxLicenseTokens = resolveStoryRoyaltyMaxLicenseTokens(input.env)
  const resolveVault = async (ipId: `0x${string}`): Promise<string | null> => {
    try {
      const vault = await storyClient.royalty?.getRoyaltyVaultAddress(ipId)
      return typeof vault === "string" && vault !== "0x0000000000000000000000000000000000000000" ? vault : null
    } catch (error) {
      console.warn("[story] royalty vault lookup failed", {
        community_id: input.communityId,
        asset_id: input.assetId,
        story_ip_id: ipId,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  if (rightsBasis === "derivative") {
    const derivativeResponse = await withStoryRegistrationRetry(() =>
      storyClient.ipAsset.registerDerivativeIpAsset({
        nft: {
          type: "mint",
          spgNftContract,
          recipient: input.creatorWalletAddress as `0x${string}`,
          allowDuplicates: true,
        },
        derivData: {
          parentIpIds: derivativeParents!.map((parent) => parent.ipId),
          licenseTermsIds: derivativeParents!.map((parent) => parent.licenseTermsId),
        },
        ipMetadata: {
          ipMetadataURI: metadata.ipMetadataUri,
          ipMetadataHash: metadata.ipMetadataHash,
          nftMetadataURI: metadata.nftMetadataUri,
          nftMetadataHash: metadata.nftMetadataHash,
        },
      }),
    )
    const derivativeIpId = derivativeResponse.ipId!
    const ipRoyaltyVault = await resolveVault(derivativeIpId)

    return {
      storyIpId: derivativeIpId,
      storyIpNftContract: spgNftContract,
      storyIpNftTokenId: derivativeResponse.tokenId!.toString(),
      ipRoyaltyVault,
      storyLicenseTermsId: null,
      storyLicenseTemplate: null,
      storyRoyaltyPolicy: royaltyPolicy,
      storyDerivativeParentIpIds: derivativeParents!.map((parent) => parent.ipId),
      storyRevenueToken: WIP_TOKEN_ADDRESS,
      storyRoyaltyRegistrationStatus: "registered",
      storyDerivativeRegisteredAt: nowIso(),
    }
  }

  const licenseTerms = resolvePilTermsForLicense({
    licensePreset: requireOriginalLicensePreset(input.licensePreset),
    commercialRevSharePct: input.commercialRevSharePct,
    defaultMintingFee,
    currency: WIP_TOKEN_ADDRESS,
    royaltyPolicy,
  })
  const originalResponse = await withStoryRegistrationRetry(() =>
    storyClient.ipAsset.registerIpAsset({
      nft: {
        type: "mint",
        spgNftContract,
        recipient: input.creatorWalletAddress as `0x${string}`,
        allowDuplicates: true,
      },
      licenseTermsData: [
        {
          terms: licenseTerms,
          maxLicenseTokens,
        },
      ],
      ipMetadata: {
        ipMetadataURI: metadata.ipMetadataUri,
        ipMetadataHash: metadata.ipMetadataHash,
        nftMetadataURI: metadata.nftMetadataUri,
        nftMetadataHash: metadata.nftMetadataHash,
      },
    }),
  )

  return {
    storyIpId: originalResponse.ipId!,
    storyIpNftContract: spgNftContract,
    storyIpNftTokenId: originalResponse.tokenId!.toString(),
    ipRoyaltyVault: await resolveVault(originalResponse.ipId!),
    storyLicenseTermsId: originalResponse.licenseTermsIds?.[0]?.toString() ?? null,
    storyLicenseTemplate: null,
    storyRoyaltyPolicy: royaltyPolicy,
    storyDerivativeParentIpIds: null,
    storyRevenueToken: WIP_TOKEN_ADDRESS,
    storyRoyaltyRegistrationStatus: "registered",
    storyDerivativeRegisteredAt: null,
  }
}
