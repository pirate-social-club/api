import type { UserRepository } from "../../auth/repositories"
import type { DbExecutor } from "../../db-helpers"
import { badRequestError, notFoundError } from "../../errors"
import { isPubliclyReadablePost } from "../../posts/post-access"
import { getPostById } from "../../posts/community-post-query-store"
import { getControlPlaneClient } from "../../runtime-deps"
import { getSongArtifactBundle } from "../../song-artifacts/song-artifact-repository"
import { fetchSongArtifactBytes } from "../../song-artifacts/song-artifact-storage"
import type {
  Asset,
  AssetAccessResponse,
  Env,
  Post,
  SongArtifactBundle,
} from "../../../types"
import { openCommunityReadClient } from "../community-read-access"
import type { CommunityDatabaseBindingRepository } from "../db-community-repository"
import {
  ANY_COMMUNITY_ROLE,
  getCommunityMembershipState,
  hasCommunityRole,
} from "../membership/membership-state-store"
import {
  buildStoryCdrAccessPackage,
  fetchPrimaryAssetContent,
} from "./asset-delivery"
import type { BuyerIdentity } from "./buyer-identity"
import { assertAssetNotRightsHeld } from "./rights-hold-gates"
import type { AssetRow } from "./row-types"
import {
  buildAssetContentPath,
  getActiveEntitlementForBuyer,
  getActiveEntitlementForBuyerIdentity,
  getAssetRow,
  requireCommunityMember,
  resolvePrimaryWalletAddress,
  serializeAsset,
} from "./shared"

async function resolveLockedSongPreviewState(input: {
  asset: AssetRow
  communityId: string
  env: Env
}): Promise<{
  bundlePreviewStatus: SongArtifactBundle["preview_status"] | null
  previewReady: boolean
}> {
  if (!input.asset.song_artifact_bundle_id) {
    return {
      bundlePreviewStatus: null,
      previewReady: true,
    }
  }
  const bundle = await getSongArtifactBundle(
    getControlPlaneClient(input.env),
    input.communityId,
    input.asset.song_artifact_bundle_id.replace(/^sab_/, ""),
  )
  return {
    bundlePreviewStatus: bundle?.preview_status ?? null,
    previewReady: bundle?.preview_status === "completed" && Boolean(bundle.preview_audio?.storage_ref),
  }
}


function buildPublicAssetContentPath(communityId: string, assetId: string): string {
  return `/public-communities/${encodeURIComponent(`com_${communityId}`)}/assets/${encodeURIComponent(`asset_${assetId}`)}/content`
}


type AuthorizedAssetAccess = {
  asset: AssetRow
  post: Post
  isPrivilegedViewer: boolean
  privilegedReason: "creator" | "moderator" | null
}

async function authorizeAssetAccess(input: {
  client: DbExecutor
  communityId: string
  userId: string
  assetId: string
  notFoundMessage: string
  unpublishedMessage?: string
}): Promise<AuthorizedAssetAccess> {
  const asset = await getAssetRow(input.client, input.communityId, input.assetId)
  if (!asset) {
    throw notFoundError(input.notFoundMessage)
  }

  const post = await getPostById(input.client, asset.source_post_id)
  const membership = await getCommunityMembershipState(input.client, input.communityId, input.userId)
  const privilegedReason = asset.creator_user_id === input.userId
    ? "creator"
    : hasCommunityRole(membership, ANY_COMMUNITY_ROLE)
      ? "moderator"
      : null
  const isPrivilegedViewer = privilegedReason != null

  if (!post) {
    throw notFoundError(input.notFoundMessage)
  }
  if (post.status !== "published" && !isPrivilegedViewer) {
    throw notFoundError(input.unpublishedMessage ?? input.notFoundMessage)
  }

  return {
    asset,
    post,
    isPrivilegedViewer,
    privilegedReason,
  }
}


export async function getCommunityAsset(input: {
  env: Env
  userId: string
  communityId: string
  assetId: string
  communityRepository: CommunityDatabaseBindingRepository
}): Promise<Asset> {
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const { asset, isPrivilegedViewer } = await authorizeAssetAccess({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
      assetId: input.assetId,
      notFoundMessage: "Asset not found",
    })
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
  communityRepository: CommunityDatabaseBindingRepository
  userRepository: UserRepository
}): Promise<AssetAccessResponse> {
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const { asset, post, isPrivilegedViewer, privilegedReason } = await authorizeAssetAccess({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
      assetId: input.assetId,
      notFoundMessage: "Asset not found",
    })

    if (asset.access_mode === "public") {
      return {
        asset: `asset_${asset.asset_id}`,
        community: `com_${asset.community_id}`,
        source_post: `post_${asset.source_post_id}`,
        access_mode: asset.access_mode,
        source_post_status: post.status === "draft" || post.status === "hidden" ? post.status : "published",
        story_status: asset.story_status,
        locked_delivery_status: asset.locked_delivery_status,
        access_granted: true,
        decision_reason: privilegedReason ?? "public",
        delivery_kind: "primary_content_ref",
        delivery_ref: buildPublicAssetContentPath(asset.community_id, asset.asset_id),
        story_cdr_access: null,
      }
    }

    if (isPrivilegedViewer) {
      const callerWalletAddress = await resolvePrimaryWalletAddress({
        env: input.env,
        userRepository: input.userRepository,
        userId: input.userId,
      })
      const decisionReason = privilegedReason ?? "creator"
      const deliveryReady = asset.locked_delivery_status === "ready"
      const previewState = deliveryReady
        ? await resolveLockedSongPreviewState({ asset, communityId: input.communityId, env: input.env })
        : { bundlePreviewStatus: null, previewReady: true }
      const accessReady = deliveryReady && previewState.previewReady
      return {
        asset: `asset_${asset.asset_id}`,
        community: `com_${asset.community_id}`,
        source_post: `post_${asset.source_post_id}`,
        access_mode: asset.access_mode,
        source_post_status: post.status === "draft" || post.status === "hidden" ? post.status : "published",
        story_status: asset.story_status,
        locked_delivery_status: asset.locked_delivery_status,
        bundle_preview_status: previewState.bundlePreviewStatus,
        access_granted: accessReady,
        decision_reason: !deliveryReady ? "delivery_pending" : previewState.previewReady ? decisionReason : "preview_pending",
        delivery_kind: accessReady ? "story_cdr_ref" : null,
        delivery_ref: accessReady ? buildAssetContentPath(asset.community_id, asset.asset_id) : null,
        story_cdr_access: accessReady
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

    const previewState = asset.locked_delivery_status === "ready"
      ? await resolveLockedSongPreviewState({ asset, communityId: input.communityId, env: input.env })
      : { bundlePreviewStatus: null, previewReady: true }
    const entitlement = await getActiveEntitlementForBuyer(
      db.client,
      input.communityId,
      input.userId,
      asset.asset_id,
      "asset_access",
    )
    if (entitlement && asset.locked_delivery_status === "ready" && previewState.previewReady) {
      const callerWalletAddress = await resolvePrimaryWalletAddress({
        env: input.env,
        userRepository: input.userRepository,
        userId: input.userId,
      })
      return {
        asset: `asset_${asset.asset_id}`,
        community: `com_${asset.community_id}`,
        source_post: `post_${asset.source_post_id}`,
        access_mode: asset.access_mode,
        source_post_status: "published",
        story_status: asset.story_status,
        locked_delivery_status: asset.locked_delivery_status,
        bundle_preview_status: previewState.bundlePreviewStatus,
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
      asset: `asset_${asset.asset_id}`,
      community: `com_${asset.community_id}`,
      source_post: `post_${asset.source_post_id}`,
      access_mode: asset.access_mode,
      source_post_status: "published",
      story_status: asset.story_status,
      locked_delivery_status: asset.locked_delivery_status,
      bundle_preview_status: previewState.bundlePreviewStatus,
      access_granted: false,
      decision_reason: asset.locked_delivery_status !== "ready"
        ? "delivery_pending"
        : previewState.previewReady
          ? "purchase_required"
          : "preview_pending",
      delivery_kind: null,
      delivery_ref: null,
      story_cdr_access: null,
    }
  } finally {
    db.close()
  }
}

export async function resolvePublicCommunityAssetAccess(input: {
  env: Env
  buyer: BuyerIdentity
  communityId: string
  assetId: string
  communityRepository: CommunityDatabaseBindingRepository
}): Promise<AssetAccessResponse> {
  if (input.buyer.kind !== "wallet") {
    throw badRequestError("Wallet buyer is required")
  }
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    const asset = await getAssetRow(db.client, input.communityId, input.assetId)
    if (!asset) {
      throw notFoundError("Asset not found")
    }
    const post = await getPostById(db.client, asset.source_post_id)
    if (!post || !isPubliclyReadablePost(post)) {
      throw notFoundError("Asset not found")
    }

    if (asset.access_mode === "public") {
      return {
        asset: `asset_${asset.asset_id}`,
        community: `com_${asset.community_id}`,
        source_post: `post_${asset.source_post_id}`,
        access_mode: asset.access_mode,
        source_post_status: "published",
        story_status: asset.story_status,
        locked_delivery_status: asset.locked_delivery_status,
        access_granted: true,
        decision_reason: "public",
        delivery_kind: "primary_content_ref",
        delivery_ref: buildAssetContentPath(asset.community_id, asset.asset_id),
        story_cdr_access: null,
      }
    }

    const entitlement = await getActiveEntitlementForBuyerIdentity(
      db.client,
      input.communityId,
      input.buyer,
      asset.asset_id,
      "asset_access",
    )
    const previewState = asset.locked_delivery_status === "ready"
      ? await resolveLockedSongPreviewState({ asset, communityId: input.communityId, env: input.env })
      : { bundlePreviewStatus: null, previewReady: true }
    if (entitlement && asset.locked_delivery_status === "ready" && previewState.previewReady) {
      return {
        asset: `asset_${asset.asset_id}`,
        community: `com_${asset.community_id}`,
        source_post: `post_${asset.source_post_id}`,
        access_mode: asset.access_mode,
        source_post_status: "published",
        story_status: asset.story_status,
        locked_delivery_status: asset.locked_delivery_status,
        bundle_preview_status: previewState.bundlePreviewStatus,
        access_granted: true,
        decision_reason: "purchase_entitlement",
        delivery_kind: "story_cdr_ref",
        delivery_ref: buildPublicAssetContentPath(asset.community_id, asset.asset_id),
        story_cdr_access: await buildStoryCdrAccessPackage({
          env: input.env,
          asset,
          callerWalletAddress: input.buyer.walletAddress,
          userId: `wallet:${input.buyer.chainRef}:${input.buyer.walletAddressNormalized}`,
          decisionReason: "purchase_entitlement",
          ciphertextRef: buildPublicAssetContentPath(asset.community_id, asset.asset_id),
        }),
      }
    }

    return {
      asset: `asset_${asset.asset_id}`,
      community: `com_${asset.community_id}`,
      source_post: `post_${asset.source_post_id}`,
      access_mode: asset.access_mode,
      source_post_status: "published",
      story_status: asset.story_status,
      locked_delivery_status: asset.locked_delivery_status,
      bundle_preview_status: previewState.bundlePreviewStatus,
      access_granted: false,
      decision_reason: asset.locked_delivery_status !== "ready"
        ? "delivery_pending"
        : previewState.previewReady
          ? "purchase_required"
          : "preview_pending",
      delivery_kind: null,
      delivery_ref: null,
      story_cdr_access: null,
    }
  } finally {
    db.close()
  }
}

export async function fetchPublicCommunityAssetContent(input: {
  env: Env
  communityId: string
  assetId: string
  communityRepository: CommunityDatabaseBindingRepository
}): Promise<Response> {
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    const asset = await getAssetRow(db.client, input.communityId, input.assetId)
    if (!asset) {
      throw notFoundError("Asset content not found")
    }
    const post = await getPostById(db.client, asset.source_post_id)
    if (!post || !isPubliclyReadablePost(post)) {
      throw notFoundError("Asset content not found")
    }
    await assertAssetNotRightsHeld({
      client: db.client,
      communityId: input.communityId,
      asset,
      mode: "public",
    })
    if (asset.access_mode === "public") {
      return await fetchPrimaryAssetContent({
        env: input.env,
        communityId: input.communityId,
        storageRef: asset.primary_content_ref,
      })
    }
    if (!asset.locked_delivery_storage_ref) {
      throw notFoundError("Asset content is not ready")
    }
    return await fetchSongArtifactBytes({
      env: input.env,
      objectKey: asset.locked_delivery_storage_ref,
    })
  } finally {
    db.close()
  }
}

export async function fetchCommunityAssetContent(input: {
  env: Env
  userId: string
  communityId: string
  assetId: string
  communityRepository: CommunityDatabaseBindingRepository
  userRepository: UserRepository
}): Promise<Response> {
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    const { asset } = await authorizeAssetAccess({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
      assetId: input.assetId,
      notFoundMessage: "Asset not found",
      unpublishedMessage: "Asset content not found",
    })
    await assertAssetNotRightsHeld({
      client: db.client,
      communityId: input.communityId,
      asset,
    })
    if (asset.access_mode === "public") {
      return await fetchPrimaryAssetContent({
        env: input.env,
        communityId: input.communityId,
        storageRef: asset.primary_content_ref,
      })
    }
    if (!asset.locked_delivery_storage_ref) {
      throw notFoundError("Asset content is not ready")
    }
    return await fetchSongArtifactBytes({
      env: input.env,
      objectKey: asset.locked_delivery_storage_ref,
    })
  } finally {
    db.close()
  }
}


