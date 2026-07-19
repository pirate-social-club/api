import { describe, expect, test } from "bun:test"
import type { SongArtifactBundle } from "../../types"
import { buildStoryRoyaltyMetadataPayloads } from "./story-royalty-metadata"

const creatorWallet = "0x2222222222222222222222222222222222222222" as const
const collaboratorWallet = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const
const mediaHash = `0x${"a".repeat(64)}` as const
const coverArtHash = `0x${"b".repeat(64)}` as const
const primaryContentHash = `0x${"d".repeat(64)}` as const
const createdAt = "2026-07-13T12:00:00.000Z"
const mediaUrl = "https://dweb.link/ipfs/song-audio"
const coverArtUrl = "https://dweb.link/ipfs/song-cover"

function buildBundle(contentHash: string = mediaHash): SongArtifactBundle {
  return {
    id: "sab_metadata_song",
    title: "Bundle title",
    primary_audio: {
      storage_ref: "https://api.test/song-artifacts/song-audio",
      mime_type: "audio/x-wav",
      content_hash: contentHash,
      decentralized_storage: {
        provider: "filebase_ipfs",
        cid: "song-audio",
        gateway_url: mediaUrl,
      },
    },
    cover_art: {
      storage_ref: coverArtUrl,
      mime_type: "image/jpeg",
      content_hash: coverArtHash,
    },
  } as unknown as SongArtifactBundle
}

function buildPayloads(input: {
  accessMode: "public" | "locked"
  contentHash?: string
  mediaHashVerified?: boolean
  royaltyShares?: boolean
}) {
  return buildStoryRoyaltyMetadataPayloads({
    communityId: "cmt_metadata",
    assetId: "ast_metadata",
    title: "Midnight Test",
    rightsBasis: "derivative",
    assetKind: "song_audio",
    creatorWalletAddress: creatorWallet,
    accessMode: input.accessMode,
    bundle: buildBundle(input.contentHash),
    primaryContentHash,
    mediaHashVerified: input.mediaHashVerified ?? true,
    derivativeParentIpIds: ["0x9999999999999999999999999999999999999999"],
    royaltyShares: input.royaltyShares === false
      ? []
      : [
          { walletAddressNormalized: creatorWallet, shareBps: 9000, percentage: 90 },
          { walletAddressNormalized: collaboratorWallet, shareBps: 1000, percentage: 10 },
        ],
    createdAt,
  })
}

describe("buildStoryRoyaltyMetadataPayloads", () => {
  test("publishes DATA music fields and playable NFT metadata for public songs", () => {
    const { ipPayload, nftPayload } = buildPayloads({ accessMode: "public" })

    expect(ipPayload).toMatchObject({
      title: "Midnight Test",
      description: "Derivative music registered by Pirate.",
      createdAt,
      creators: [
        {
          name: "Pirate creator",
          address: creatorWallet,
          contributionPercent: 90,
          role: "Creator",
        },
        {
          name: "Pirate collaborator",
          address: collaboratorWallet,
          contributionPercent: 10,
          role: "Collaborator",
        },
      ],
      image: coverArtUrl,
      imageHash: coverArtHash,
      mediaUrl,
      mediaHash,
      mediaType: "audio/wav",
      primary_content_hash: primaryContentHash,
    })
    expect(nftPayload).toMatchObject({
      name: "Midnight Test",
      description: "Derivative music registered by Pirate.",
      image: coverArtUrl,
      animation_url: mediaUrl,
      attributes: [
        { key: "asset_id", trait_type: "asset_id", value: "ast_metadata" },
        { key: "rights_basis", trait_type: "rights_basis", value: "derivative" },
      ],
    })
  })

  test("keeps locked audio out of public IP and NFT metadata", () => {
    const { ipPayload, nftPayload } = buildPayloads({ accessMode: "locked", royaltyShares: false })

    expect(ipPayload.creators).toEqual([
      {
        name: "Pirate creator",
        address: creatorWallet,
        contributionPercent: 100,
        role: "Creator",
      },
    ])
    expect(ipPayload).not.toHaveProperty("mediaUrl")
    expect(ipPayload).not.toHaveProperty("mediaHash")
    expect(ipPayload).not.toHaveProperty("mediaType")
    expect(nftPayload).not.toHaveProperty("animation_url")
  })

  test("never substitutes the reference-derived primary hash for a missing byte hash", () => {
    const { ipPayload, nftPayload } = buildPayloads({ accessMode: "public", contentHash: "0xabc123" })

    expect(ipPayload.primary_content_hash).toBe(primaryContentHash)
    expect(ipPayload).not.toHaveProperty("mediaHash")
    expect(ipPayload).not.toHaveProperty("mediaUrl")
    expect(ipPayload).not.toHaveProperty("mediaType")
    expect(nftPayload.animation_url).toBe(mediaUrl)
  })

  test("withholds a structurally valid but unverified client hash", () => {
    const { ipPayload, nftPayload } = buildPayloads({
      accessMode: "public",
      mediaHashVerified: false,
    })

    expect(ipPayload).not.toHaveProperty("mediaHash")
    expect(ipPayload).not.toHaveProperty("mediaUrl")
    expect(ipPayload).not.toHaveProperty("mediaType")
    expect(nftPayload.animation_url).toBe(mediaUrl)
  })

  test("publishes poster and playable metadata for a public video", () => {
    const videoUrl = "https://pirate.sc/api/communities/cmt_metadata/song-artifacts/sau_video/content"
    const posterUrl = "https://dweb.link/ipfs/video-poster"
    const { ipPayload, nftPayload } = buildStoryRoyaltyMetadataPayloads({
      communityId: "cmt_metadata",
      assetId: "ast_video",
      title: "Video Test",
      rightsBasis: "original",
      assetKind: "video_file",
      creatorWalletAddress: creatorWallet,
      accessMode: "public",
      bundle: null,
      media: {
        mediaUrl: videoUrl,
        mediaType: "video/mp4",
        mediaHash,
        imageUrl: posterUrl,
      },
      primaryContentHash,
      mediaHashVerified: true,
      derivativeParentIpIds: null,
      royaltyShares: [],
      createdAt,
    })

    expect(ipPayload).toMatchObject({
      image: posterUrl,
      mediaUrl: videoUrl,
      mediaHash,
      mediaType: "video/mp4",
      cover_art_ref: posterUrl,
    })
    expect(nftPayload).toMatchObject({
      image: posterUrl,
      animation_url: videoUrl,
    })
  })

  test("does not publish internal video or poster storage references", () => {
    const { ipPayload, nftPayload } = buildStoryRoyaltyMetadataPayloads({
      communityId: "cmt_metadata",
      assetId: "ast_video",
      title: "Locked Video",
      rightsBasis: "original",
      assetKind: "video_file",
      creatorWalletAddress: creatorWallet,
      accessMode: "locked",
      bundle: null,
      media: {
        mediaUrl: "r2://private/video.mp4",
        mediaType: "video/mp4",
        mediaHash,
        imageUrl: "r2://private/poster.jpg",
      },
      primaryContentHash,
      mediaHashVerified: true,
      derivativeParentIpIds: null,
      royaltyShares: [],
      createdAt,
    })

    expect(ipPayload).not.toHaveProperty("image")
    expect(ipPayload).not.toHaveProperty("mediaUrl")
    expect(nftPayload).not.toHaveProperty("image")
    expect(nftPayload).not.toHaveProperty("animation_url")
  })
})
