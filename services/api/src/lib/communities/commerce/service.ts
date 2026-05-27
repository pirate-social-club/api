import type { Client } from "../../sql-client"
import { badRequestError, conflictError, notFoundError, providerUnavailable } from "../../errors"
import { nowIso } from "../../helpers"
import {
  ANY_COMMUNITY_ROLE,
  getCommunityMembershipState,
  hasCommunityRole,
} from "../membership/membership-state-store"
import { openCommunityDb } from "../community-db-factory"
import type { CommunityDatabaseBindingRepository } from "../db-community-repository"
import { getPostById } from "../../posts/community-post-query-store"
import { isPubliclyReadablePost } from "../../posts/post-access"
import { fetchSongArtifactBytes } from "../../song-artifacts/song-artifact-storage"
import { sha256Hex } from "../../crypto"
import { getProfilePublicHandleLabel } from "../../auth/auth-serializers"
import type { UserRepository } from "../../auth/repositories"
import type { ProfileRepository } from "../../auth/repositories"
import {
  isStoryRoyaltyRegistrationConfigured,
  maybeRegisterStoryRoyaltyForAsset,
  type StoryLicensePreset,
} from "../../story/story-royalty-registration-service"
import type { AssetRow } from "./row-types"
import {
  buildAssetContentPath,
  getActiveEntitlementForBuyer,
  getActiveEntitlementForBuyerIdentity,
  findRegisteredOriginalStoryAssetByContent,
  findReusableRegisteredOriginalStoryAssetByContent,
  getAssetRow,
  listDerivativeSourceRows,
  requireCommunityMember,
  resolvePrimaryWalletAddress,
  serializeAsset,
  type DerivativeSourceRow,
} from "./shared"
import type { BuyerIdentity } from "./buyer-identity"
import {
  buildStoryCdrAccessPackage,
  fetchPrimaryAssetContent,
  prepareLockedAssetDelivery,
} from "./asset-delivery"
import type {
  Asset,
  AssetAccessResponse,
  DerivativeSource,
  DerivativeSourceKind,
  DerivativeSourceListResponse,
  Env,
  Post,
  SongArtifactBundle,
  SongArtifactUpload,
} from "../../../types"

function isStoryRoyaltyAssetKind(assetKind: Asset["asset_kind"]): assetKind is "song_audio" | "video_file" {
  return assetKind === "song_audio" || assetKind === "video_file"
}

function derivativeSourceKindFromAssetKind(assetKind: Asset["asset_kind"]): DerivativeSourceKind {
  return assetKind === "video_file" ? "video" : "song"
}

function derivativeSourceStoryRef(row: DerivativeSourceRow): string | null {
  const storyIpId = row.story_ip_id?.trim()
  const storyLicenseTermsId = row.story_license_terms_id?.trim()
  if (!storyIpId || !storyLicenseTermsId) {
    return null
  }
  return `story:ip:${storyIpId}#licenseTermsId=${storyLicenseTermsId}`
}

function shouldAttemptStoryRoyaltyRegistration(input: {
  assetKind: Asset["asset_kind"]
  rightsBasis: Post["rights_basis"] | null
  hasSongBundle: boolean
}): boolean {
  const isRoyaltyRightsBasis = input.rightsBasis === "original" || input.rightsBasis === "derivative"
  if (!isStoryRoyaltyAssetKind(input.assetKind) || !isRoyaltyRightsBasis) {
    return false
  }
  return input.assetKind !== "song_audio" || input.hasSongBundle
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
  client: Client
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

export async function createAssetForPost(input: {
  env: Env
  client: Pick<Client, "execute">
  communityId: string
  post: Post
  assetKind: Asset["asset_kind"]
  storageRef: string
  mimeType: string
  contentHash: string | null
  artifactKind: SongArtifactUpload["artifact_kind"]
  bundleId: string | null
  bundle?: SongArtifactBundle | null
  displayTitle?: string | null
  licensePreset?: StoryLicensePreset | null
  commercialRevSharePct?: number | null
  requireStoryRoyaltyRegistration?: boolean
  userRepository: UserRepository
}): Promise<Asset> {
  if (!input.post.asset_id?.trim()) {
    throw badRequestError("Post is missing asset_id")
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
  let publicationStatus: Asset["publication_status"] = "draft"
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
  const shouldRegisterRoyalty = shouldAttemptStoryRoyaltyRegistration({
    assetKind: input.assetKind,
    rightsBasis: input.post.rights_basis ?? "none",
    hasSongBundle: Boolean(input.bundle),
  })
  let storyRoyaltyRegistrationStatus: "none" | "pending" | "registered" | "failed" =
    shouldRegisterRoyalty
      ? "pending"
      : "none"
  let storyPublishTxRef: string | null = null
  let storyAssetVersionId: string | null = null
  let storyCdrVaultUuid: number | null = null
  let storyNamespace: string | null = null
  let storyEntitlementTokenId: string | null = null
  let storyReadCondition: string | null = null
  let storyWriteCondition: string | null = null
  let creatorWalletAddress: string | null = null
  const resolvedPrimaryContentHash = (input.contentHash?.trim() || `0x${await sha256Hex(input.storageRef)}`) as `0x${string}`
  let effectiveLicensePreset = input.licensePreset ?? null
  let effectiveCommercialRevSharePct = input.commercialRevSharePct ?? null

  if (shouldRegisterRoyalty && (input.post.rights_basis ?? "none") === "derivative") {
    const registeredOriginal = await findRegisteredOriginalStoryAssetByContent({
      client: input.client,
      communityId: input.communityId,
      creatorUserId: input.post.author_user_id ?? "",
      assetKind: input.assetKind,
      primaryContentHash: resolvedPrimaryContentHash,
    })
    if (registeredOriginal) {
      throw conflictError(
        "This exact file was already registered on Story as an original. Story registrations cannot be changed into remixes; upload the remixed audio file, or publish these same bytes as an original to reuse the existing Story registration.",
        {
          reason: "story_original_content_already_registered",
          existing_asset_id: registeredOriginal.asset_id,
          existing_source_post_id: registeredOriginal.source_post_id,
          existing_story_ip_id: registeredOriginal.story_ip_id,
          primary_content_hash: resolvedPrimaryContentHash,
        },
      )
    }
  }

  if ((input.post.access_mode ?? "public") === "locked") {
    try {
      creatorWalletAddress = await resolvePrimaryWalletAddress({
        env: input.env,
        userRepository: input.userRepository,
        userId: input.post.author_user_id ?? "",
      })
      const lockedDelivery = await prepareLockedAssetDelivery({
        env: input.env,
        communityId: input.communityId,
        assetId: input.post.asset_id,
        creatorWalletAddress,
        storageRef: input.storageRef,
        mimeType: input.mimeType,
        contentHash: input.contentHash,
        artifactKind: input.artifactKind,
        bundleId: input.bundleId,
        rightsBasis: input.post.rights_basis ?? "none",
        upstreamAssetRefs: input.post.upstream_asset_refs ?? null,
      })
      storyStatus = lockedDelivery.storyStatus
      if (lockedDelivery.storyStatus === "published") {
        publicationStatus = "story_published"
      }
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
    const shouldRunRoyaltyRegistration = shouldRegisterRoyalty && storyRoyaltyRegistrationStatus !== "registered"
    const reusableOriginalRegistration = shouldRunRoyaltyRegistration && (input.post.rights_basis ?? "none") === "original"
      ? await findReusableRegisteredOriginalStoryAssetByContent({
          client: input.client,
          communityId: input.communityId,
          creatorUserId: input.post.author_user_id ?? "",
          assetKind: input.assetKind,
          primaryContentHash: resolvedPrimaryContentHash,
        })
      : null

    if (reusableOriginalRegistration) {
      storyIpId = reusableOriginalRegistration.story_ip_id
      storyIpNftContract = reusableOriginalRegistration.story_ip_nft_contract
      storyIpNftTokenId = reusableOriginalRegistration.story_ip_nft_token_id
      storyPublishModel = reusableOriginalRegistration.story_publish_model
      storyLicenseTermsId = reusableOriginalRegistration.story_license_terms_id
      storyLicenseTemplate = reusableOriginalRegistration.story_license_template
      storyRoyaltyPolicy = reusableOriginalRegistration.story_royalty_policy
      storyRoyaltyPolicyId = reusableOriginalRegistration.story_royalty_policy_id
      storyDerivativeParentIpIdsJson = reusableOriginalRegistration.story_derivative_parent_ip_ids_json
      storyDerivativeRegisteredAt = reusableOriginalRegistration.story_derivative_registered_at
      storyRevenueToken = reusableOriginalRegistration.story_revenue_token
      storyRoyaltyRegistrationStatus = "registered"
      storyStatus = "published"
      publicationStatus = "story_published"
      storyError = null
      storyPublishTxRef = reusableOriginalRegistration.story_publish_tx_ref
      storyAssetVersionId = reusableOriginalRegistration.story_asset_version_id
      storyCdrVaultUuid = reusableOriginalRegistration.story_cdr_vault_uuid
      storyNamespace = reusableOriginalRegistration.story_namespace
      storyEntitlementTokenId = reusableOriginalRegistration.story_entitlement_token_id
      storyReadCondition = reusableOriginalRegistration.story_read_condition
      storyWriteCondition = reusableOriginalRegistration.story_write_condition
      effectiveLicensePreset = reusableOriginalRegistration.license_preset as StoryLicensePreset | null
      effectiveCommercialRevSharePct = reusableOriginalRegistration.commercial_rev_share_pct
    }

    if (shouldRunRoyaltyRegistration && !reusableOriginalRegistration && !creatorWalletAddress) {
      creatorWalletAddress = await resolvePrimaryWalletAddress({
        env: input.env,
        userRepository: input.userRepository,
        userId: input.post.author_user_id ?? "",
      })
    }
    const royaltyRegistration = shouldRunRoyaltyRegistration && !reusableOriginalRegistration
      ? await maybeRegisterStoryRoyaltyForAsset({
          env: input.env,
          client: input.client,
          communityId: input.communityId,
          assetId: input.post.asset_id,
          creatorWalletAddress: creatorWalletAddress ?? "",
          title: input.post.title ?? null,
          rightsBasis: input.post.rights_basis ?? "none",
          licensePreset: effectiveLicensePreset,
          commercialRevSharePct: effectiveCommercialRevSharePct,
          upstreamAssetRefs: input.post.upstream_asset_refs ?? null,
          assetKind: input.assetKind,
          bundle: input.bundle ?? null,
          primaryContentHash: resolvedPrimaryContentHash,
        })
      : null
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
      storyStatus = "published"
      publicationStatus = "story_published"
    } else if (shouldRegisterRoyalty && storyRoyaltyRegistrationStatus === "pending") {
      const registrationError = isStoryRoyaltyRegistrationConfigured(input.env)
        ? "story_royalty_registration_unavailable"
        : "story_royalty_config_missing"
      storyRoyaltyRegistrationStatus = "failed"
      storyError = storyError
        ? `${storyError};royalty_registration_failed:${registrationError}`
        : `royalty_registration_failed:${registrationError}`
    }
  } catch (error) {
    const registrationError = error instanceof Error ? error.message : String(error)
    storyRoyaltyRegistrationStatus = "failed"
    storyError = storyError ? `${storyError};royalty_registration_failed:${registrationError}` : `royalty_registration_failed:${registrationError}`
  }

  if (shouldRegisterRoyalty && storyRoyaltyRegistrationStatus === "failed" && input.requireStoryRoyaltyRegistration) {
    throw providerUnavailable("Story registration is required before publishing this asset")
  }

  await input.client.execute({
    sql: `
      INSERT INTO assets (
        asset_id, community_id, source_post_id, display_title, song_artifact_bundle_id, creator_user_id, asset_kind,
        rights_basis, access_mode, license_preset, commercial_rev_share_pct,
        primary_content_ref, primary_content_hash, publication_status,
        story_status, story_error, story_ip_id, story_ip_nft_contract, story_ip_nft_token_id,
        story_publish_model, story_license_terms_id, story_license_template, story_royalty_policy,
        story_royalty_policy_id, story_derivative_parent_ip_ids_json, story_derivative_registered_at,
        story_revenue_token, story_royalty_registration_status, locked_delivery_status, locked_delivery_ref,
        locked_delivery_error, created_at, updated_at, story_publish_tx_ref, story_asset_version_id,
        story_cdr_vault_uuid, story_namespace, story_entitlement_token_id, story_read_condition,
        story_write_condition, locked_delivery_storage_ref, locked_delivery_secret_json
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7,
        ?8, ?9, ?10, ?11,
        ?12, ?13, ?14,
        ?15, ?16, ?17, ?18, ?19,
        ?20, ?21, ?22, ?23, ?24,
        ?25, ?26, ?27, ?28, ?29,
        ?30, ?31, ?32, ?32, ?33,
        ?34, ?35, ?36, ?37, ?38,
        ?39, ?40, ?41
      )
    `,
    args: [
      input.post.asset_id,
      input.communityId,
      input.post.post_id,
      input.displayTitle?.trim() || input.post.title?.trim() || null,
      input.bundleId,
      input.post.author_user_id ?? "",
      input.assetKind,
      input.post.rights_basis ?? "none",
      input.post.access_mode ?? "public",
      effectiveLicensePreset,
      effectiveCommercialRevSharePct,
      input.storageRef,
      resolvedPrimaryContentHash,
      publicationStatus,
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

export async function createSongAssetForPost(input: {
  env: Env
  client: Pick<Client, "execute">
  communityId: string
  post: Post
  bundle: SongArtifactBundle
  licensePreset: StoryLicensePreset | null
  commercialRevSharePct: number | null
  requireStoryRoyaltyRegistration?: boolean
  userRepository: UserRepository
}): Promise<Asset> {
  return await createAssetForPost({
    env: input.env,
    client: input.client,
    communityId: input.communityId,
    post: input.post,
    assetKind: "song_audio",
    storageRef: input.bundle.primary_audio.storage_ref,
    mimeType: input.bundle.primary_audio.mime_type,
    contentHash: input.bundle.primary_audio.content_hash ?? null,
    artifactKind: "primary_audio",
    bundleId: input.bundle.id,
    bundle: input.bundle,
    displayTitle: input.bundle.title,
    licensePreset: input.licensePreset,
    commercialRevSharePct: input.commercialRevSharePct,
    requireStoryRoyaltyRegistration: input.requireStoryRoyaltyRegistration,
    userRepository: input.userRepository,
  })
}

export async function getCommunityAsset(input: {
  env: Env
  userId: string
  communityId: string
  assetId: string
  communityRepository: CommunityDatabaseBindingRepository
}): Promise<Asset> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
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

export async function listCommunityDerivativeSources(input: {
  env: Env
  userId: string
  communityId: string
  kind?: DerivativeSourceKind | null
  query?: string | null
  limit: number
  communityRepository: CommunityDatabaseBindingRepository
  profileRepository: ProfileRepository
}): Promise<DerivativeSourceListResponse> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const rows = await listDerivativeSourceRows({
      client: db.client,
      communityId: input.communityId,
      kind: input.kind,
      query: input.query,
      limit: input.limit,
    })
    const creatorUserIds = Array.from(new Set(rows.map((row) => row.creator_user_id)))
    const profilesByUserId = new Map(await Promise.all(creatorUserIds.map(async (userId) => [
      userId,
      await input.profileRepository.getProfileByUserId(userId).catch(() => null),
    ] as const)))
    const items: DerivativeSource[] = rows.map((row) => {
      const profile = profilesByUserId.get(row.creator_user_id) ?? null
      const sourceRef = derivativeSourceStoryRef(row)
      if (!sourceRef) {
        throw new Error("Derivative source is missing Story registration fields")
      }
      return {
        id: `asset_${row.asset_id}`,
        object: "derivative_source",
        community: `com_${row.community_id}`,
        asset: `asset_${row.asset_id}`,
        source_ref: sourceRef,
        title: row.display_title?.trim() || "Untitled asset",
        kind: derivativeSourceKindFromAssetKind(row.asset_kind),
        story_ip: row.story_ip_id!,
        story_license_terms: row.story_license_terms_id!,
        license_preset: row.license_preset,
        commercial_rev_share_pct: row.commercial_rev_share_pct,
        creator_user: `usr_${row.creator_user_id}`,
        creator_handle: profile ? getProfilePublicHandleLabel(profile) : null,
        creator_display_name: profile?.display_name ?? null,
      }
    })

    return {
      items,
      next_cursor: null,
    }
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
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
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
      return {
        asset: `asset_${asset.asset_id}`,
        community: `com_${asset.community_id}`,
        source_post: `post_${asset.source_post_id}`,
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
        asset: `asset_${asset.asset_id}`,
        community: `com_${asset.community_id}`,
        source_post: `post_${asset.source_post_id}`,
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
      asset: `asset_${asset.asset_id}`,
      community: `com_${asset.community_id}`,
      source_post: `post_${asset.source_post_id}`,
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
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
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
    )
    if (entitlement && asset.locked_delivery_status === "ready") {
      return {
        asset: `asset_${asset.asset_id}`,
        community: `com_${asset.community_id}`,
        source_post: `post_${asset.source_post_id}`,
        access_mode: asset.access_mode,
        source_post_status: "published",
        story_status: asset.story_status,
        locked_delivery_status: asset.locked_delivery_status,
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

export async function fetchPublicCommunityAssetContent(input: {
  env: Env
  communityId: string
  assetId: string
  communityRepository: CommunityDatabaseBindingRepository
}): Promise<Response> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const asset = await getAssetRow(db.client, input.communityId, input.assetId)
    if (!asset) {
      throw notFoundError("Asset content not found")
    }
    const post = await getPostById(db.client, asset.source_post_id)
    if (!post || !isPubliclyReadablePost(post)) {
      throw notFoundError("Asset content not found")
    }
    if (asset.access_mode === "public" || !asset.locked_delivery_storage_ref) {
      return await fetchPrimaryAssetContent({
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

export async function fetchCommunityAssetContent(input: {
  env: Env
  userId: string
  communityId: string
  assetId: string
  communityRepository: CommunityDatabaseBindingRepository
  userRepository: UserRepository
}): Promise<Response> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const { asset } = await authorizeAssetAccess({
      client: db.client,
      communityId: input.communityId,
      userId: input.userId,
      assetId: input.assetId,
      notFoundMessage: "Asset not found",
      unpublishedMessage: "Asset content not found",
    })
    if (asset.access_mode === "public" || !asset.locked_delivery_storage_ref) {
      return await fetchPrimaryAssetContent({
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
export * from "./listing-service"
export * from "./quote-service"
export * from "./settlement-service"
