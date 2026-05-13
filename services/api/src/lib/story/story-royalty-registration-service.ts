import { StoryClient, WIP_TOKEN_ADDRESS, PILFlavor, royaltyPolicyLapAddress } from "@story-protocol/core-sdk"
import { http } from "viem"
import { privateKeyToAccount } from "viem/accounts"
import type { Client } from "../sql-client"
import type { Env } from "../../env"
import type { Post, SongArtifactBundle } from "../../types"
import { nowIso } from "../helpers"
import { resolveStoryOperatorDirectSigner } from "./story-direct-signer"
import { resolveStoryChainId, resolveStoryRpcUrl } from "./story-runtime-config"
import { getAssetRow } from "../communities/commerce/queries"
import { decodePublicAssetId } from "../public-ids"
import { publishStoryJsonMetadata } from "./story-metadata-publisher"

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

let testRoyaltyRegistrar: ((input: {
  env: Env
  client: Client
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

export function setStoryRoyaltyRegistrarForTests(
  registrar: ((input: {
    env: Env
    client: Client
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

function resolveStoryRoyaltyCommercialRevSharePct(
  env: Pick<Env, "STORY_ROYALTY_COMMERCIAL_REV_SHARE_PCT">,
): number | null {
  const raw = String(env.STORY_ROYALTY_COMMERCIAL_REV_SHARE_PCT || "").trim()
  if (!raw) return null
  const parsed = Number(raw)
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 100 ? parsed : null
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
  env: Pick<Env, "STORY_ROYALTY_SPG_NFT_CONTRACT" | "STORY_ROYALTY_COMMERCIAL_REV_SHARE_PCT">,
): boolean {
  return Boolean(
    resolveStoryRoyaltySpgNftContract(env)
    && resolveStoryRoyaltyCommercialRevSharePct(env) !== null,
  )
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
  client: Client
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
    primary_content_hash: input.primaryContentHash,
    derivative_parent_ip_ids: input.derivativeParentIpIds,
    created_at: nowIso(),
  }
  const nftPayload = {
    name: input.title?.trim() || `Pirate Asset ${input.assetId}`,
    description: input.rightsBasis === "derivative"
      ? "Derivative Story-native Pirate commerce asset"
      : "Original Story-native Pirate commerce asset",
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
  client: Client
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

  const client = StoryClient.newClient({
    account: privateKeyToAccount(operator.value.privateKey as `0x${string}`),
    transport: http(resolveStoryRpcUrl(input.env)),
    chainId: resolveStoryChainName(input.env),
  })

  const royaltyPolicy = resolveStoryRoyaltyPolicyAddress(input.env)
  const defaultMintingFee = resolveStoryRoyaltyDefaultMintingFee(input.env)
  const licenseTerms = rightsBasis === "original"
    ? resolvePilTermsForLicense({
      licensePreset: requireOriginalLicensePreset(input.licensePreset),
      commercialRevSharePct: input.commercialRevSharePct,
      defaultMintingFee,
      currency: WIP_TOKEN_ADDRESS,
      royaltyPolicy,
    })
    : PILFlavor.commercialRemix({
      commercialRevShare: validateCommercialRevSharePct(resolveStoryRoyaltyCommercialRevSharePct(input.env)),
      defaultMintingFee,
      currency: WIP_TOKEN_ADDRESS,
      royaltyPolicy,
    })
  const maxLicenseTokens = resolveStoryRoyaltyMaxLicenseTokens(input.env)

  if (rightsBasis === "derivative") {
    const derivativeResponse = await client.ipAsset.registerDerivativeIpAsset({
      nft: {
        type: "mint",
        spgNftContract,
        recipient: input.creatorWalletAddress as `0x${string}`,
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
    })

    const attached = await client.license.registerPilTermsAndAttach({
      ipId: derivativeResponse.ipId!,
      licenseTermsData: [
        {
          terms: licenseTerms,
          maxLicenseTokens,
        },
      ],
    })

    return {
      storyIpId: derivativeResponse.ipId!,
      storyIpNftContract: spgNftContract,
      storyIpNftTokenId: derivativeResponse.tokenId!.toString(),
      storyLicenseTermsId: attached.licenseTermsIds?.[0]?.toString() ?? null,
      storyLicenseTemplate: null,
      storyRoyaltyPolicy: royaltyPolicy,
      storyDerivativeParentIpIds: derivativeParents!.map((parent) => parent.ipId),
      storyRevenueToken: WIP_TOKEN_ADDRESS,
      storyRoyaltyRegistrationStatus: "registered",
      storyDerivativeRegisteredAt: nowIso(),
    }
  }

  const originalResponse = await client.ipAsset.registerIpAsset({
    nft: {
      type: "mint",
      spgNftContract,
      recipient: input.creatorWalletAddress as `0x${string}`,
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
