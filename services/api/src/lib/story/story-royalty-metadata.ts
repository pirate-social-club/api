import type { SongArtifactBundle } from "../../types"
import type { StoryRoyaltyShareRow } from "../communities/commerce/royalty-allocations"

export type StoryRoyaltyMetadataAccessMode = "public" | "locked"
export type StoryRoyaltyMetadataAssetKind = "song_audio" | "video_file"
export type StoryRoyaltyMetadataRightsBasis = "none" | "original" | "derivative"

function publicMetadataUri(value: unknown): string | null {
  const uri = typeof value === "string" ? value.trim() : ""
  return /^(?:https?:\/\/|ipfs:\/\/)/i.test(uri) ? uri : null
}

function sha256MetadataHash(value: unknown): `0x${string}` | null {
  const hash = typeof value === "string" ? value.trim().toLowerCase() : ""
  return /^0x[0-9a-f]{64}$/.test(hash) ? hash as `0x${string}` : null
}

function storyMediaType(value: unknown): string | null {
  const mimeType = typeof value === "string" ? value.trim().toLowerCase() : ""
  if (mimeType === "audio/x-wav") return "audio/wav"
  if (mimeType === "audio/mp3") return "audio/mpeg"
  return mimeType || null
}

function songMediaUri(bundle: SongArtifactBundle | null): string | null {
  const decentralizedStorage = bundle?.primary_audio?.decentralized_storage
  const gatewayUrl = decentralizedStorage && typeof decentralizedStorage === "object"
    ? (decentralizedStorage as Record<string, unknown>).gateway_url
    : null
  return publicMetadataUri(gatewayUrl) ?? publicMetadataUri(bundle?.primary_audio?.storage_ref)
}

function storyMetadataCreators(input: {
  creatorWalletAddress: string
  royaltyShares: StoryRoyaltyShareRow[]
}) {
  const shares = input.royaltyShares.length > 0
    ? input.royaltyShares
    : [{
        walletAddressNormalized: input.creatorWalletAddress as `0x${string}`,
        shareBps: 10_000,
        percentage: 100,
      }]
  const creatorWallet = input.creatorWalletAddress.trim().toLowerCase()
  return shares.map((share) => {
    const isPrimaryCreator = share.walletAddressNormalized.toLowerCase() === creatorWallet
    return {
      name: isPrimaryCreator ? "Pirate creator" : "Pirate collaborator",
      address: share.walletAddressNormalized,
      contributionPercent: share.percentage,
      role: isPrimaryCreator ? "Creator" : "Collaborator",
    }
  })
}

export function buildStoryRoyaltyMetadataPayloads(input: {
  communityId: string
  assetId: string
  title: string | null
  rightsBasis: StoryRoyaltyMetadataRightsBasis
  assetKind: StoryRoyaltyMetadataAssetKind
  creatorWalletAddress: string
  accessMode: StoryRoyaltyMetadataAccessMode
  bundle: SongArtifactBundle | null
  primaryContentHash: `0x${string}`
  mediaHashVerified: boolean
  derivativeParentIpIds: string[] | null
  royaltyShares: StoryRoyaltyShareRow[]
  createdAt: string
}) {
  const coverArtRef = input.bundle?.cover_art?.storage_ref?.trim() || null
  const coverArtUri = publicMetadataUri(coverArtRef)
  const coverArtHash = sha256MetadataHash(input.bundle?.cover_art?.content_hash)
  const title = input.title?.trim() || input.bundle?.title?.trim() || `Pirate Asset ${input.assetId}`
  const assetLabel = input.assetKind === "song_audio" ? "music" : "video"
  const description = input.rightsBasis === "derivative"
    ? `Derivative ${assetLabel} registered by Pirate.`
    : `Original ${assetLabel} registered by Pirate.`
  const creators = storyMetadataCreators({
    creatorWalletAddress: input.creatorWalletAddress,
    royaltyShares: input.royaltyShares,
  })
  const mediaUri = input.assetKind === "song_audio" && input.accessMode === "public"
    ? songMediaUri(input.bundle)
    : null
  const mediaHash = input.mediaHashVerified
    ? sha256MetadataHash(input.bundle?.primary_audio?.content_hash)
    : null
  const mediaType = storyMediaType(input.bundle?.primary_audio?.mime_type)
  const canonicalMedia = mediaUri && mediaHash && mediaType
    ? { mediaUrl: mediaUri, mediaHash, mediaType }
    : {}

  return {
    ipPayload: {
      version: 1,
      kind: "pirate_story_ip_metadata",
      community_id: input.communityId,
      asset_id: input.assetId,
      asset_kind: input.assetKind,
      title,
      description,
      createdAt: input.createdAt,
      creators,
      ...(coverArtUri ? { image: coverArtUri } : {}),
      ...(coverArtUri && coverArtHash ? { imageHash: coverArtHash } : {}),
      ...canonicalMedia,
      rights_basis: input.rightsBasis,
      creator_wallet_address: input.creatorWalletAddress,
      song_artifact_bundle_id: input.bundle?.id.replace(/^sab_/, "") ?? null,
      cover_art_ref: coverArtRef,
      primary_content_hash: input.primaryContentHash,
      derivative_parent_ip_ids: input.derivativeParentIpIds,
      created_at: input.createdAt,
    },
    nftPayload: {
      name: title,
      description,
      ...(coverArtUri ? { image: coverArtUri } : {}),
      ...(mediaUri ? { animation_url: mediaUri } : {}),
      external_url: `pirate://communities/${input.communityId}/assets/${input.assetId}`,
      attributes: [
        { key: "asset_id", trait_type: "asset_id", value: input.assetId },
        { key: "rights_basis", trait_type: "rights_basis", value: input.rightsBasis },
      ],
    },
  }
}
