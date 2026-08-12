import { describe, expect, test } from "bun:test"
import type { AssetRow } from "./row-types"
import type { Post } from "../../../types"
import { registerLockedStoryRoyalty } from "./locked-delivery-service"

describe("registerLockedStoryRoyalty", () => {
  test("passes canonical video media through the locked-delivery registration callsite", async () => {
    let captured: Record<string, unknown> | null = null
    let capturedMediaInput: Record<string, unknown> | null = null
    type BuildVideoMetadataMedia = NonNullable<
      NonNullable<Parameters<typeof registerLockedStoryRoyalty>[0]["dependencies"]>["buildVideoMetadataMedia"]
    >
    const expectedMedia = {
      mediaUrl: null,
      verificationStorageRef: "https://dweb.link/ipfs/video",
      mediaType: "video/mp4",
      mediaHash: `0x${"a".repeat(64)}`,
      imageUrl: "https://dweb.link/ipfs/video-poster",
    }
    const buildVideoMetadataMedia: BuildVideoMetadataMedia = (input) => {
      capturedMediaInput = input as unknown as Record<string, unknown>
      return expectedMedia
    }
    type RegisterStoryRoyalty = NonNullable<
      NonNullable<Parameters<typeof registerLockedStoryRoyalty>[0]["dependencies"]>["registerStoryRoyalty"]
    >
    const registerStoryRoyalty: RegisterStoryRoyalty = async (input) => {
      captured = input as unknown as Record<string, unknown>
      return {
        storyIpId: "0x1111111111111111111111111111111111111111",
        storyIpNftContract: "0x2222222222222222222222222222222222222222",
        storyIpNftTokenId: "1",
        storyIpMetadataUri: "ipfs://ip-metadata",
        storyIpMetadataHash: `0x${"b".repeat(64)}`,
        storyNftMetadataUri: "ipfs://nft-metadata",
        storyNftMetadataHash: `0x${"c".repeat(64)}`,
        ipRoyaltyVault: null,
        storyLicenseTermsId: "1",
        storyLicenseTemplate: "0x3333333333333333333333333333333333333333",
        storyRoyaltyPolicy: "0x4444444444444444444444444444444444444444",
        storyDerivativeParentIpIds: null,
        storyRevenueToken: "0x5555555555555555555555555555555555555555",
        storyRoyaltyRegistrationStatus: "registered" as const,
        storyDerivativeRegisteredAt: null,
        royaltyDistributionTxHash: null,
      }
    }
    const post = {
      post_type: "video",
      title: "Locked video",
      media_refs: [{
        storage_ref: "",
        mime_type: "video/mp4",
        poster_ref: "https://dweb.link/ipfs/video-poster",
      }],
    } as Post
    const asset = {
      access_mode: "locked",
      asset_id: "ast_video",
      asset_kind: "video_file",
      primary_content_hash: `0x${"a".repeat(64)}`,
      primary_content_ref: "https://dweb.link/ipfs/video",
      rights_basis: "original",
    } as AssetRow

    const result = await registerLockedStoryRoyalty({
      env: {} as never,
      client: { execute: async () => ({ rows: [] }) },
      communityId: "cmt_video",
      asset,
      post,
      bundle: null,
      creatorWalletAddress: "0x6666666666666666666666666666666666666666",
      resolvedPrimaryContentHash: asset.primary_content_hash as `0x${string}`,
      effectiveLicensePreset: "non-commercial",
      effectiveCommercialRevSharePct: null,
      dependencies: { buildVideoMetadataMedia, registerStoryRoyalty },
    })

    expect(result).not.toBeNull()
    expect(capturedMediaInput).toEqual({
      post,
      storageRef: asset.primary_content_ref,
      mimeType: "video/mp4",
      contentHash: asset.primary_content_hash,
    })
    expect(captured).toMatchObject({
      media: expectedMedia,
    })
  })
})
