import type { Client } from "../../sql-client"
import { badRequestError, notFoundError } from "../../errors"
import { nowIso } from "../../helpers"
import { getCommunityMembershipState } from "../membership/store"
import { openCommunityDb } from "../community-db-factory"
import type { CommunityRepository } from "../db-community-repository"
import { getPostById } from "../../posts/community-post-store"
import { fetchSongArtifactBytes } from "../../song-artifacts/song-artifact-storage"
import { sha256Hex } from "../../crypto"
import type { UserRepository } from "../../auth/repositories"
import { maybeRegisterStoryRoyaltyForAsset } from "../../story/story-royalty-registration-service"
import {
  buildAssetContentPath,
  getActiveEntitlementForBuyer,
  getAssetRow,
  requireCommunityMember,
  resolvePrimaryWalletAddress,
  serializeAsset,
} from "./shared"
import {
  buildStoryCdrAccessPackage,
  fetchPrimarySongAssetContent,
  prepareLockedSongAssetDelivery,
} from "./asset-delivery"
import type {
  Asset,
  AssetAccessResponse,
  Env,
  Post,
  SongArtifactBundle,
} from "../../../types"

export async function createSongAssetForPost(input: {
  env: Env
  client: Client
  communityId: string
  post: Post
  bundle: SongArtifactBundle
  userRepository: UserRepository
}): Promise<Asset> {
  if (!input.post.asset_id?.trim()) {
    throw badRequestError("Song post is missing asset_id")
  }
  const existing = await getAssetRow(input.client, input.communityId, input.post.asset_id)
  if (existing) {
    return serializeAsset(existing)
  }
  const createdAt = nowIso()
  let lockedDeliveryStatus: Asset["locked_delivery_status"] = "none"
  let lockedDeliveryRef: string | null = null
  let lockedDeliveryError: string | null = null
  let lockedDeliveryStorageRef: string | null = null
  let lockedDeliveryMetadataJson: string | null = null
  let storyStatus: Asset["story_status"] = "none"
  let storyError: string | null = null
  let storyIpId: string | null = null
  let storyIpNftContract: string | null = null
  let storyIpNftTokenId: string | null = null
  let storyPublishModel: "pirate_v1" | "story_ip_v1" = "pirate_v1"
  let storyLicenseTermsId: string | null = null
  let storyLicenseTemplate: string | null = null
  let storyRoyaltyPolicy: string | null = null
  let storyRoyaltyPolicyId: string | null = null
  let storyDerivativeParentIpIdsJson: string | null = null
  let storyDerivativeRegisteredAt: string | null = null
  let storyRevenueToken: string | null = null
  let storyRoyaltyRegistrationStatus: "none" | "pending" | "registered" | "failed" =
    input.post.rights_basis === "original" || input.post.rights_basis === "derivative" ? "pending" : "none"
  let storyPublishTxRef: string | null = null
  let storyAssetVersionId: string | null = null
  let storyCdrVaultUuid: number | null = null
  let storyNamespace: string | null = null
  let storyEntitlementTokenId: string | null = null
  let storyReadCondition: string | null = null
  let storyWriteCondition: string | null = null
  let creatorWalletAddress: string | null = null

  if ((input.post.access_mode ?? "public") === "locked") {
    try {
      creatorWalletAddress = await resolvePrimaryWalletAddress({
        env: input.env,
        userRepository: input.userRepository,
        userId: input.post.author_user_id ?? "",
      })
      const lockedDelivery = await prepareLockedSongAssetDelivery({
        env: input.env,
        communityId: input.communityId,
        assetId: input.post.asset_id,
        creatorWalletAddress,
        bundle: input.bundle,
        rightsBasis: input.post.rights_basis ?? "none",
        upstreamAssetRefs: input.post.upstream_asset_refs ?? null,
      })
      storyStatus = lockedDelivery.storyStatus
      storyPublishTxRef = lockedDelivery.storyPublishTxRef
      storyIpId = lockedDelivery.storyIpId
      storyRoyaltyPolicyId = lockedDelivery.storyRoyaltyPolicyId
      storyDerivativeParentIpIdsJson = lockedDelivery.storyDerivativeParentIpIdsJson
      if (lockedDelivery.storyRoyaltyRegistrationStatus) {
        storyRoyaltyRegistrationStatus = lockedDelivery.storyRoyaltyRegistrationStatus
      }
      storyAssetVersionId = lockedDelivery.storyAssetVersionId
      storyCdrVaultUuid = lockedDelivery.storyCdrVaultUuid
      storyNamespace = lockedDelivery.storyNamespace
      storyEntitlementTokenId = lockedDelivery.storyEntitlementTokenId
      storyReadCondition = lockedDelivery.storyReadCondition
      storyWriteCondition = lockedDelivery.storyWriteCondition
      lockedDeliveryStatus = lockedDelivery.lockedDeliveryStatus
      lockedDeliveryRef = lockedDelivery.lockedDeliveryRef
      lockedDeliveryStorageRef = lockedDelivery.lockedDeliveryStorageRef
      lockedDeliveryMetadataJson = lockedDelivery.lockedDeliveryMetadataJson
    } catch (error) {
      storyStatus = "failed"
      storyError = error instanceof Error ? error.message : String(error)
      if ((input.post.rights_basis ?? "none") === "derivative") {
        storyRoyaltyRegistrationStatus = "failed"
      }
      lockedDeliveryStatus = "failed"
      lockedDeliveryError = storyError
      throw badRequestError(`Locked delivery preparation failed: ${lockedDeliveryError}`)
    }
  }

  try {
    if (!creatorWalletAddress) {
      creatorWalletAddress = await resolvePrimaryWalletAddress({
        env: input.env,
        userRepository: input.userRepository,
        userId: input.post.author_user_id ?? "",
      })
    }
    const royaltyRegistration = await maybeRegisterStoryRoyaltyForAsset({
      env: input.env,
      client: input.client,
      communityId: input.communityId,
      assetId: input.post.asset_id,
      creatorWalletAddress,
      title: input.post.title ?? null,
      rightsBasis: input.post.rights_basis ?? "none",
      upstreamAssetRefs: input.post.upstream_asset_refs ?? null,
      bundle: input.bundle,
      primaryContentHash:
        (input.bundle.primary_audio.content_hash?.trim() || `0x${await sha256Hex(input.bundle.primary_audio.storage_ref)}`) as `0x${string}`,
    })
    if (royaltyRegistration) {
      storyIpId = royaltyRegistration.storyIpId
      storyIpNftContract = royaltyRegistration.storyIpNftContract
      storyIpNftTokenId = royaltyRegistration.storyIpNftTokenId
      storyPublishModel = "story_ip_v1"
      storyLicenseTermsId = royaltyRegistration.storyLicenseTermsId
      storyLicenseTemplate = royaltyRegistration.storyLicenseTemplate
      storyRoyaltyPolicy = royaltyRegistration.storyRoyaltyPolicy
      storyRoyaltyPolicyId = royaltyRegistration.storyRoyaltyPolicy
      storyDerivativeParentIpIdsJson = royaltyRegistration.storyDerivativeParentIpIds
        ? JSON.stringify(royaltyRegistration.storyDerivativeParentIpIds)
        : null
      storyDerivativeRegisteredAt = royaltyRegistration.storyDerivativeRegisteredAt
      storyRevenueToken = royaltyRegistration.storyRevenueToken
      storyRoyaltyRegistrationStatus = royaltyRegistration.storyRoyaltyRegistrationStatus
    }
  } catch (error) {
    const registrationError = error instanceof Error ? error.message : String(error)
    storyRoyaltyRegistrationStatus = "failed"
    storyError = storyError ? `${storyError};royalty_registration_failed:${registrationError}` : `royalty_registration_failed:${registrationError}`
  }

  await input.client.execute({
    sql: `
      INSERT INTO assets (
        asset_id, community_id, source_post_id, song_artifact_bundle_id, creator_user_id, asset_kind,
        rights_basis, access_mode, primary_content_ref, primary_content_hash, publication_status,
        story_status, story_error, story_ip_id, story_ip_nft_contract, story_ip_nft_token_id,
        story_publish_model, story_license_terms_id, story_license_template, story_royalty_policy,
        story_royalty_policy_id, story_derivative_parent_ip_ids_json, story_derivative_registered_at,
        story_revenue_token, story_royalty_registration_status, locked_delivery_status, locked_delivery_ref,
        locked_delivery_error, created_at, updated_at, story_publish_tx_ref, story_asset_version_id,
        story_cdr_vault_uuid, story_namespace, story_entitlement_token_id, story_read_condition,
        story_write_condition, locked_delivery_storage_ref, locked_delivery_secret_json
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, 'song_audio',
        ?6, ?7, ?8, ?9, 'draft',
        ?10, ?11, ?12, ?13, ?14,
        ?15, ?16, ?17, ?18, ?19,
        ?20, ?21, ?22, ?23, ?24,
        ?25, ?26, ?27, ?27, ?28,
        ?29, ?30, ?31, ?32, ?33,
        ?34, ?35, ?36
      )
    `,
    args: [
      input.post.asset_id,
      input.communityId,
      input.post.post_id,
      input.post.song_artifact_bundle_id ?? null,
      input.post.author_user_id ?? "",
      input.post.rights_basis ?? "none",
      input.post.access_mode ?? "public",
      input.bundle.primary_audio.storage_ref,
      input.bundle.primary_audio.content_hash ?? `0x${await sha256Hex(input.bundle.primary_audio.storage_ref)}`,
      storyStatus,
      storyError,
      storyIpId,
      storyIpNftContract,
      storyIpNftTokenId,
      storyPublishModel,
      storyLicenseTermsId,
      storyLicenseTemplate,
      storyRoyaltyPolicy,
      storyRoyaltyPolicyId,
      storyDerivativeParentIpIdsJson,
      storyDerivativeRegisteredAt,
      storyRevenueToken,
      storyRoyaltyRegistrationStatus,
      lockedDeliveryStatus,
      lockedDeliveryRef,
      lockedDeliveryError,
      createdAt,
      storyPublishTxRef,
      storyAssetVersionId,
      storyCdrVaultUuid,
      storyNamespace,
      storyEntitlementTokenId,
      storyReadCondition,
      storyWriteCondition,
      lockedDeliveryStorageRef,
      lockedDeliveryMetadataJson,
    ],
  })
  const asset = await getAssetRow(input.client, input.communityId, input.post.asset_id)
  if (!asset) {
    throw notFoundError("Asset not found")
  }
  return serializeAsset(asset)
}

export async function getCommunityAsset(input: {
  env: Env
  userId: string
  communityId: string
  assetId: string
  communityRepository: CommunityRepository
}): Promise<Asset> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const asset = await getAssetRow(db.client, input.communityId, input.assetId)
    if (!asset) {
      throw notFoundError("Asset not found")
    }
    const post = await getPostById(db.client, asset.source_post_id)
    const isPrivilegedViewer = asset.creator_user_id === input.userId
      || (await getCommunityMembershipState(db.client, input.communityId, input.userId)).role_status === "active"
    if (!post) {
      throw notFoundError("Asset not found")
    }
    if (post.status !== "published" && !isPrivilegedViewer) {
      throw notFoundError("Asset not found")
    }
    return serializeAsset(asset, { redactPrimaryForLocked: !isPrivilegedViewer })
  } finally {
    db.close()
  }
}

export async function resolveCommunityAssetAccess(input: {
  env: Env
  userId: string
  communityId: string
  assetId: string
  communityRepository: CommunityRepository
  userRepository: UserRepository
}): Promise<AssetAccessResponse> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const asset = await getAssetRow(db.client, input.communityId, input.assetId)
    if (!asset) {
      throw notFoundError("Asset not found")
    }
    const post = await getPostById(db.client, asset.source_post_id)
    const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
    const isPrivilegedViewer = asset.creator_user_id === input.userId || membership.role_status === "active"
    if (!post) {
      throw notFoundError("Asset not found")
    }
    if (post.status !== "published" && !isPrivilegedViewer) {
      throw notFoundError("Asset not found")
    }

    if (asset.access_mode === "public") {
      return {
        asset_id: asset.asset_id,
        community_id: asset.community_id,
        source_post_id: asset.source_post_id,
        access_mode: asset.access_mode,
        source_post_status: post.status === "draft" || post.status === "hidden" ? post.status : "published",
        story_status: asset.story_status,
        locked_delivery_status: asset.locked_delivery_status,
        access_granted: true,
        decision_reason: isPrivilegedViewer ? "creator" : "public",
        delivery_kind: "primary_content_ref",
        delivery_ref: buildAssetContentPath(asset.community_id, asset.asset_id),
        story_cdr_access: null,
      }
    }

    if (isPrivilegedViewer) {
      const callerWalletAddress = await resolvePrimaryWalletAddress({
        env: input.env,
        userRepository: input.userRepository,
        userId: input.userId,
      })
      const decisionReason = membership.role_status === "active" && asset.creator_user_id !== input.userId ? "moderator" : "creator"
      return {
        asset_id: asset.asset_id,
        community_id: asset.community_id,
        source_post_id: asset.source_post_id,
        access_mode: asset.access_mode,
        source_post_status: post.status === "draft" || post.status === "hidden" ? post.status : "published",
        story_status: asset.story_status,
        locked_delivery_status: asset.locked_delivery_status,
        access_granted: asset.locked_delivery_status === "ready",
        decision_reason: decisionReason,
        delivery_kind: asset.locked_delivery_status === "ready" ? "story_cdr_ref" : null,
        delivery_ref: asset.locked_delivery_status === "ready" ? buildAssetContentPath(asset.community_id, asset.asset_id) : null,
        story_cdr_access: asset.locked_delivery_status === "ready"
          ? await buildStoryCdrAccessPackage({
            env: input.env,
            asset,
            callerWalletAddress,
            userId: input.userId,
            decisionReason,
          })
          : null,
      }
    }

    const entitlement = await getActiveEntitlementForBuyer(db.client, input.communityId, input.userId, asset.asset_id)
    if (entitlement && asset.locked_delivery_status === "ready") {
      const callerWalletAddress = await resolvePrimaryWalletAddress({
        env: input.env,
        userRepository: input.userRepository,
        userId: input.userId,
      })
      return {
        asset_id: asset.asset_id,
        community_id: asset.community_id,
        source_post_id: asset.source_post_id,
        access_mode: asset.access_mode,
        source_post_status: "published",
        story_status: asset.story_status,
        locked_delivery_status: asset.locked_delivery_status,
        access_granted: true,
        decision_reason: "purchase_entitlement",
        delivery_kind: "story_cdr_ref",
        delivery_ref: buildAssetContentPath(asset.community_id, asset.asset_id),
        story_cdr_access: await buildStoryCdrAccessPackage({
          env: input.env,
          asset,
          callerWalletAddress,
          userId: input.userId,
          decisionReason: "purchase_entitlement",
        }),
      }
    }

    return {
      asset_id: asset.asset_id,
      community_id: asset.community_id,
      source_post_id: asset.source_post_id,
      access_mode: asset.access_mode,
      source_post_status: "published",
      story_status: asset.story_status,
      locked_delivery_status: asset.locked_delivery_status,
      access_granted: false,
      decision_reason: asset.locked_delivery_status === "ready" ? "purchase_required" : "delivery_pending",
      delivery_kind: null,
      delivery_ref: null,
      story_cdr_access: null,
    }
  } finally {
    db.close()
  }
}

export async function fetchCommunityAssetContent(input: {
  env: Env
  userId: string
  communityId: string
  assetId: string
  communityRepository: CommunityRepository
  userRepository: UserRepository
}): Promise<Response> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const asset = await getAssetRow(db.client, input.communityId, input.assetId)
    if (!asset) {
      throw notFoundError("Asset not found")
    }
    const post = await getPostById(db.client, asset.source_post_id)
    const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
    const isPrivilegedViewer = asset.creator_user_id === input.userId || membership.role_status === "active"
    if (!post) {
      throw notFoundError("Asset not found")
    }
    if (post.status !== "published" && !isPrivilegedViewer) {
      throw notFoundError("Asset content not found")
    }
    if (asset.access_mode === "public" || !asset.locked_delivery_storage_ref) {
      return await fetchPrimarySongAssetContent({
        env: input.env,
        communityId: input.communityId,
        storageRef: asset.primary_content_ref,
      })
    }
    return await fetchSongArtifactBytes({
      env: input.env,
      objectKey: asset.locked_delivery_storage_ref,
    })
  } finally {
    db.close()
  }
}

export * from "./policy-service"
export * from "./purchase-service"
