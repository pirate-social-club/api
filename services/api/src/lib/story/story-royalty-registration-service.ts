import { StoryClient, WIP_TOKEN_ADDRESS, PILFlavor, royaltyPolicyLapAddress } from "@story-protocol/core-sdk"
import { http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import type { Client } from "../sql-client"
import type { Env } from "../../env"
import type { Post, SongArtifactBundle } from "../../types"
import { nowIso } from "../helpers"
import { logPipelineError, logPipelineInfo, sanitizeLogText, summarizeReference } from "../observability/pipeline-log"
import { resolveStoryOperatorDirectSigner } from "./story-direct-signer"
import { resolveStoryChainId, resolveStoryRpcUrl, resolveStoryRuntimeSignerTargetBalanceWei } from "./story-runtime-config"
import { getAssetRow } from "../communities/commerce/queries"
import { decodePublicAssetId } from "../public-ids"
import { publishStoryJsonMetadata } from "./story-metadata-publisher"
import { assertStoryRuntimeSignerFunding } from "./story-runtime-funding"

type StoryRoyaltyClient = Pick<Client, "execute">
type StoryRoyaltyRightsBasis = "none" | "original" | "derivative"
export type StoryLicensePreset = "non-commercial" | "commercial-use" | "commercial-remix"
type StoryRoyaltyAssetKind = "song_audio" | "video_file"

export type StoryRoyaltyRegistrationResult = {
  storyIpId: string
  storyIpNftContract: string
  storyIpNftTokenId: string
  storyLicenseTermsId: string | null
  storyLicenseTemplate: string | null
  storyRoyaltyPolicy: string
  storyDerivativeParentIpIds: string[] | null
  storyRevenueToken: string
  storyRoyaltyRegistrationStatus: "registered"
  storyDerivativeRegisteredAt: string | null
}

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
  license?: StoryLicenseClient
}

function errorRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null
}

function storySdkErrorDiagnostics(error: unknown): Record<string, unknown> {
  const record = errorRecord(error)
  const cause = record ? errorRecord(record.cause) : null
  const response = record ? errorRecord(record.response) : null
  const request = record ? errorRecord(record.request) : null
  const data = response ? response.data : null

  return {
    error_name: error instanceof Error ? error.name : typeof error,
    error_message: sanitizeLogText(error instanceof Error ? error.message : String(error)),
    error_code: record?.code ?? null,
    error_status: record?.status ?? response?.status ?? null,
    response_status: response?.status ?? null,
    response_status_text: sanitizeLogText(response?.statusText),
    response_body: sanitizeLogText(typeof data === "string" ? data : data ? JSON.stringify(data) : null),
    request_method: sanitizeLogText(request?.method),
    request_url: summarizeReference("request_url", typeof request?.url === "string" ? request.url : null),
    cause_name: cause?.name ?? null,
    cause_message: sanitizeLogText(cause?.message),
    own_keys: record ? Object.keys(record).slice(0, 20) : [],
  }
}

function storySdkErrorMessage(error: unknown): string {
  const diagnostics = storySdkErrorDiagnostics(error)
  return JSON.stringify({
    name: diagnostics.error_name,
    message: diagnostics.error_message,
    code: diagnostics.error_code,
    status: diagnostics.error_status,
    responseStatus: diagnostics.response_status,
    responseStatusText: diagnostics.response_status_text,
    responseBody: diagnostics.response_body,
    requestMethod: diagnostics.request_method,
    requestUrl: diagnostics.request_url,
    causeName: diagnostics.cause_name,
    causeMessage: diagnostics.cause_message,
    keys: diagnostics.own_keys,
  })
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
}) => Promise<StoryRoyaltyRegistrationResult | null>) | null = null

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
  }) => Promise<StoryRoyaltyRegistrationResult | null>) | null,
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

  return StoryClient.newClient({
    account: privateKeyToAccount(input.operatorPrivateKey),
    transport: http(resolveStoryRpcUrl(input.env)),
    chainId: resolveStoryChainName(input.env),
  }) as StoryRoyaltySdkClient
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
    return await testRoyaltyRegistrar(input)
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
  try {
    await assertStoryRuntimeSignerFunding(input.env, [
      { name: "story-operator", minBalanceWei: storyOperatorMinimumBalanceWei },
    ])
  } catch (error) {
    throw new Error(`story_operator_funding_check_failed:${storySdkErrorMessage(error)}`)
  }

  let metadata: Awaited<ReturnType<typeof buildStoryRoyaltyMetadata>>
  try {
    metadata = await buildStoryRoyaltyMetadata({
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
  } catch (error) {
    throw new Error(`story_metadata_publish_failed:${storySdkErrorMessage(error)}`)
  }

  let storyClient: StoryRoyaltySdkClient
  try {
    storyClient = createStoryRoyaltySdkClient({
      env: input.env,
      operatorPrivateKey: operator.value.privateKey as `0x${string}`,
    })
  } catch (error) {
    throw new Error(`story_sdk_client_create_failed:${storySdkErrorMessage(error)}`)
  }

  const royaltyPolicy = resolveStoryRoyaltyPolicyAddress(input.env)
  const defaultMintingFee = resolveStoryRoyaltyDefaultMintingFee(input.env)
  const maxLicenseTokens = resolveStoryRoyaltyMaxLicenseTokens(input.env)

  if (rightsBasis === "derivative") {
    const derivativeParentIpIds = derivativeParents!.map((parent) => parent.ipId)
    const derivativeLicenseTermsIds = derivativeParents!.map((parent) => parent.licenseTermsId)
    const derivativeRequest = {
      nft: {
        type: "mint" as const,
        spgNftContract,
        recipient: input.creatorWalletAddress as `0x${string}`,
        allowDuplicates: true,
      },
      derivData: {
        parentIpIds: derivativeParentIpIds,
        licenseTermsIds: derivativeLicenseTermsIds,
      },
      ipMetadata: {
        ipMetadataURI: metadata.ipMetadataUri,
        ipMetadataHash: metadata.ipMetadataHash,
        nftMetadataURI: metadata.nftMetadataUri,
        nftMetadataHash: metadata.nftMetadataHash,
      },
    }
    logPipelineInfo("[story-royalty] registerDerivativeIpAsset request", {
      community_id: input.communityId,
      asset_id: input.assetId,
      asset_kind: input.assetKind,
      rights_basis: rightsBasis,
      spg_nft_contract: spgNftContract,
      recipient: input.creatorWalletAddress,
      parent_ip_ids: derivativeParentIpIds,
      license_terms_ids: derivativeLicenseTermsIds.map((value) => value.toString()),
      ip_metadata_hash: metadata.ipMetadataHash,
      nft_metadata_hash: metadata.nftMetadataHash,
      ...summarizeReference("ip_metadata_uri", metadata.ipMetadataUri),
      ...summarizeReference("nft_metadata_uri", metadata.nftMetadataUri),
    })
    let derivativeResponse: Awaited<ReturnType<StoryIpAssetClient["registerDerivativeIpAsset"]>>
    try {
      derivativeResponse = await storyClient.ipAsset.registerDerivativeIpAsset(derivativeRequest)
    } catch (error) {
      const diagnosticsMessage = storySdkErrorMessage(error)
      logPipelineError("[story-royalty] registerDerivativeIpAsset failed", {
        community_id: input.communityId,
        asset_id: input.assetId,
        asset_kind: input.assetKind,
        rights_basis: rightsBasis,
        spg_nft_contract: spgNftContract,
        recipient: input.creatorWalletAddress,
        parent_ip_ids: derivativeParentIpIds,
        license_terms_ids: derivativeLicenseTermsIds.map((value) => value.toString()),
        ip_metadata_hash: metadata.ipMetadataHash,
        nft_metadata_hash: metadata.nftMetadataHash,
        ...summarizeReference("ip_metadata_uri", metadata.ipMetadataUri),
        ...summarizeReference("nft_metadata_uri", metadata.nftMetadataUri),
        ...storySdkErrorDiagnostics(error),
      })
      throw new Error(`registerDerivativeIpAsset_failed:${diagnosticsMessage}`)
    }
    const derivativeIpId = derivativeResponse.ipId!

    return {
      storyIpId: derivativeIpId,
      storyIpNftContract: spgNftContract,
      storyIpNftTokenId: derivativeResponse.tokenId!.toString(),
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
  const originalResponse = await storyClient.ipAsset.registerIpAsset({
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
  })

  return {
    storyIpId: originalResponse.ipId!,
    storyIpNftContract: spgNftContract,
    storyIpNftTokenId: originalResponse.tokenId!.toString(),
    storyLicenseTermsId: originalResponse.licenseTermsIds?.[0]?.toString() ?? null,
    storyLicenseTemplate: null,
    storyRoyaltyPolicy: royaltyPolicy,
    storyDerivativeParentIpIds: null,
    storyRevenueToken: WIP_TOKEN_ADDRESS,
    storyRoyaltyRegistrationStatus: "registered",
    storyDerivativeRegisteredAt: null,
  }
}
