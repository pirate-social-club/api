import type { Client, InStatement } from "../../sql-client"
import type { RoyaltyAllocationRequest } from "../../../types"
import {
  ROYALTY_ALLOCATION_VERSION,
  assertExistingAssetAllocationMatches,
  buildStoryRoyaltySharesFromAllocationRows,
  buildAllocationInsertStatements,
  buildAllocationRows,
  fingerprintForRequest,
  markStoryRoyaltyAllocationRegistrationPendingVerification,
  persistAssetWithAllocations,
  resolveAllocationChainId,
  resolveCreatorWalletSnapshot,
} from "./royalty-allocations"
import type { DbExecutor } from "../../db-helpers"
import { badRequestError, notFoundError, providerUnavailable } from "../../errors"
import { envFlag, isLocalEnvironment, nowIso } from "../../helpers"
import { logPipelineInfo } from "../../observability/pipeline-log"
import {
  ANY_COMMUNITY_ROLE,
  getCommunityMembershipState,
  hasCommunityRole,
} from "../membership/membership-state-store"
import { openCommunityReadClient } from "../community-read-access"
import type { CommunityDatabaseBindingRepository } from "../db-community-repository"
import { getPostById } from "../../posts/community-post-query-store"
import { isPubliclyReadablePost } from "../../posts/post-access"
import { fetchSongArtifactBytes } from "../../song-artifacts/song-artifact-storage"
import { getSongArtifactBundle } from "../../song-artifacts/song-artifact-repository"
import { findUploadedSongArtifactByStorageRef } from "../../song-artifacts/song-artifact-upload-repository"
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
  classifyStoryRegistrationFailure,
  isStoryRegistrationFailureRetryable,
  sanitizeStoryRegistrationFailure,
  storyRegistrationFailureMessage,
} from "./story-registration-failure"
import {
  buildAssetContentPath,
  getActiveEntitlementForBuyer,
  getActiveEntitlementForBuyerIdentity,
  findReusableRegisteredOriginalStoryAssetByContent,
  getAssetRow,
  listDerivativeSourceRows,
  requireCommunityMember,
  resolvePrimaryWalletAddress,
  serializeAsset,
  type DerivativeSourceRow,
} from "./shared"
import type { BuyerIdentity } from "./buyer-identity"
import { getControlPlaneClient } from "../../runtime-deps"
import {
  buildStoryCdrAccessPackage,
  fetchPrimaryAssetContent,
  prepareLockedAssetDelivery,
} from "./asset-delivery"
import {
  listStoryRegisteredAssetProjectionRows,
  upsertStoryRegisteredAssetProjection,
} from "./derivative-source-projection"
import { syncStoryRoyaltyAllocationProjectionForAsset } from "./royalty-allocation-projection"
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

async function syncStoryRoyaltyAllocationProjectionSafely(input: {
  env: Env
  client: Pick<Client, "execute">
  communityId: string
  postId: string
  assetId: string
  sourceUpdatedAt?: string | null
}): Promise<void> {
  try {
    const result = await syncStoryRoyaltyAllocationProjectionForAsset(input)
    if (result.projectedRows > 0) {
      logPipelineInfo("[commerce] Story royalty allocation projection synced", {
        community_id: input.communityId,
        post_id: input.postId,
        asset_id: input.assetId,
        projected_rows: result.projectedRows,
      })
    }
  } catch (error) {
    logPipelineInfo("[commerce] Story royalty allocation projection sync failed", {
      level: "warn",
      community_id: input.communityId,
      post_id: input.postId,
      asset_id: input.assetId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

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

export type DerivativeSourceScope = "community" | "global"

function derivativeSourceComposerUserIdCandidates(userId: string): string[] {
  const trimmed = userId.trim()
  if (!trimmed) return [userId]
  const internalUserId = trimmed.replace(/^(usr_)+/, "")
  return Array.from(new Set([trimmed, internalUserId, `usr_${internalUserId}`, `usr_${trimmed}`]))
}

async function requireDerivativeSourceComposerCommunity(input: {
  env: Env
  userId: string
  communityId: string
  communityRepository: CommunityDatabaseBindingRepository
}): Promise<void> {
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    let lastError: unknown = null
    for (const candidateUserId of derivativeSourceComposerUserIdCandidates(input.userId)) {
      try {
        await requireCommunityMember(db.client, input.communityId, candidateUserId)
        return
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  } finally {
    db.close()
  }
}

async function listGlobalDerivativeSourceRows(input: {
  env: Env
  kind?: DerivativeSourceKind | null
  query?: string | null
  limit: number
}): Promise<DerivativeSourceRow[]> {
  return await listStoryRegisteredAssetProjectionRows({
    env: input.env,
    kind: input.kind,
    query: input.query,
    limit: input.limit,
  })
}

async function derivativeSourceRowsToResponse(input: {
  rows: DerivativeSourceRow[]
  profileRepository: ProfileRepository
}): Promise<DerivativeSourceListResponse> {
  const creatorUserIds = Array.from(new Set(input.rows.map((row) => row.creator_user_id)))
  const profilesByUserId = new Map(await Promise.all(creatorUserIds.map(async (userId) => [
    userId,
    await input.profileRepository.getProfileByUserId(userId).catch(() => null),
  ] as const)))
  const items: DerivativeSource[] = input.rows.map((row) => {
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

function hasCompleteStoryRoyaltyRegistration(asset: AssetRow): boolean {
  return asset.story_royalty_registration_status === "registered"
    && Boolean(asset.story_ip_id?.trim())
    && Boolean(asset.story_license_terms_id?.trim())
}

async function retryExistingStoryRoyaltyRegistration(input: {
  env: Env
  client: Pick<Client, "execute">
  communityId: string
  post: Post
  asset: AssetRow
  bundle?: SongArtifactBundle | null
  userRepository: UserRepository
}): Promise<AssetRow> {
  const asset = input.asset
  const resolvedPrimaryContentHash = (asset.primary_content_hash?.trim() || `0x${await sha256Hex(asset.primary_content_ref)}`) as `0x${string}`
  let storyError: string | null = asset.story_error
  let storyStatus: Asset["story_status"] = asset.story_status
  let publicationStatus: Asset["publication_status"] = asset.publication_status
  let storyIpId: string | null = asset.story_ip_id
  let storyIpNftContract: string | null = asset.story_ip_nft_contract
  let storyIpNftTokenId: string | null = asset.story_ip_nft_token_id
  let ipRoyaltyVault: string | null = asset.ip_royalty_vault
  let storyPublishModel: "pirate_v1" | "story_ip_v1" = asset.story_publish_model
  let storyLicenseTermsId: string | null = asset.story_license_terms_id
  let storyLicenseTemplate: string | null = asset.story_license_template
  let storyRoyaltyPolicy: string | null = asset.story_royalty_policy
  let storyRoyaltyPolicyId: string | null = asset.story_royalty_policy_id
  let storyDerivativeParentIpIdsJson: string | null = asset.story_derivative_parent_ip_ids_json
  let storyDerivativeRegisteredAt: string | null = asset.story_derivative_registered_at
  let storyRevenueToken: string | null = asset.story_revenue_token
  let storyRoyaltyRegistrationStatus = asset.story_royalty_registration_status
  let storyPublishTxRef: string | null = asset.story_publish_tx_ref
  let storyAssetVersionId: string | null = asset.story_asset_version_id
  let storyCdrVaultUuid: number | null = asset.story_cdr_vault_uuid
  let storyNamespace: string | null = asset.story_namespace
  let storyEntitlementTokenId: string | null = asset.story_entitlement_token_id
  let storyReadCondition: string | null = asset.story_read_condition
  let storyWriteCondition: string | null = asset.story_write_condition
  let effectiveLicensePreset = asset.license_preset as StoryLicensePreset | null
  let effectiveCommercialRevSharePct = asset.commercial_rev_share_pct

  try {
    const reusableOriginalRegistration = asset.rights_basis === "original" && asset.royalty_allocation_status === "none"
      ? await findReusableRegisteredOriginalStoryAssetByContent({
          client: input.client,
          communityId: input.communityId,
          creatorUserId: asset.creator_user_id,
          assetKind: asset.asset_kind,
          primaryContentHash: resolvedPrimaryContentHash,
        })
      : null

    if (reusableOriginalRegistration) {
      storyIpId = reusableOriginalRegistration.story_ip_id
      storyIpNftContract = reusableOriginalRegistration.story_ip_nft_contract
      storyIpNftTokenId = reusableOriginalRegistration.story_ip_nft_token_id
      ipRoyaltyVault = reusableOriginalRegistration.ip_royalty_vault
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
    } else {
      const creatorWalletAddress = await resolvePrimaryWalletAddress({
        env: input.env,
        userRepository: input.userRepository,
        userId: asset.creator_user_id,
      })
      const royaltyRegistration = await maybeRegisterStoryRoyaltyForAsset({
        env: input.env,
        client: input.client,
        communityId: input.communityId,
        assetId: asset.asset_id,
        creatorWalletAddress,
        title: input.post.title ?? null,
        rightsBasis: asset.rights_basis,
        licensePreset: effectiveLicensePreset,
        commercialRevSharePct: effectiveCommercialRevSharePct,
        upstreamAssetRefs: input.post.upstream_asset_refs ?? null,
        assetKind: asset.asset_kind,
        bundle: input.bundle ?? null,
        primaryContentHash: resolvedPrimaryContentHash,
      })
      if (royaltyRegistration) {
        storyIpId = royaltyRegistration.storyIpId
        storyIpNftContract = royaltyRegistration.storyIpNftContract
        storyIpNftTokenId = royaltyRegistration.storyIpNftTokenId
        ipRoyaltyVault = royaltyRegistration.ipRoyaltyVault ?? null
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
        storyError = null
        if (asset.rights_basis === "derivative" && !royaltyRegistration.storyLicenseTermsId) {
          effectiveLicensePreset = null
          effectiveCommercialRevSharePct = null
        }
        await markStoryRoyaltyAllocationRegistrationPendingVerification({
          client: input.client,
          communityId: input.communityId,
          assetId: asset.asset_id,
          ipRoyaltyVault,
          distributionTxHash: royaltyRegistration.royaltyDistributionTxHash,
          registeredAt: nowIso(),
        })
      } else {
        const registrationError = isStoryRoyaltyRegistrationConfigured(input.env)
          ? "story_royalty_registration_unavailable"
          : "story_royalty_config_missing"
        storyRoyaltyRegistrationStatus = "failed"
        storyError = `royalty_registration_failed:${registrationError}`
      }
    }
  } catch (error) {
    const registrationError = error instanceof Error ? error.message : String(error)
    storyRoyaltyRegistrationStatus = "failed"
    storyError = `royalty_registration_failed:${registrationError}`
  }

  if (storyRoyaltyRegistrationStatus === "failed") {
    const sanitizedStoryError = sanitizeStoryRegistrationFailure(storyError)
    await input.client.execute({
      sql: `
        UPDATE assets
        SET story_status = 'failed',
            story_error = ?3,
            story_royalty_registration_status = 'failed',
            updated_at = ?4
        WHERE community_id = ?1
          AND asset_id = ?2
      `,
      args: [input.communityId, asset.asset_id, sanitizedStoryError, nowIso()],
    })
    const storyErrorClass = classifyStoryRegistrationFailure(storyError)
    console.error("[commerce] existing asset required Story registration failed again", {
      community_id: input.communityId,
      post_id: input.post.post_id,
      asset_id: asset.asset_id,
      asset_kind: asset.asset_kind,
      rights_basis: asset.rights_basis,
      story_error_class: storyErrorClass,
      story_error: sanitizedStoryError,
    })
    throw providerUnavailable(
      storyRegistrationFailureMessage(storyError),
      {
        reason: "story_royalty_registration_failed",
        community_id: input.communityId,
        post_id: input.post.post_id,
        asset_id: asset.asset_id,
        asset_kind: asset.asset_kind,
        rights_basis: asset.rights_basis,
        primary_content_hash: resolvedPrimaryContentHash,
        upstream_asset_ref_count: input.post.upstream_asset_refs?.length ?? 0,
        story_error_class: storyErrorClass,
      },
      isStoryRegistrationFailureRetryable(storyErrorClass),
    )
  }

  const updatedAt = nowIso()
  await input.client.execute({
    sql: `
      UPDATE assets
      SET publication_status = ?3,
          story_status = ?4,
          story_error = ?5,
          story_ip_id = ?6,
          story_ip_nft_contract = ?7,
          story_ip_nft_token_id = ?8,
          ip_royalty_vault = ?9,
          story_publish_model = ?10,
          story_license_terms_id = ?11,
          story_license_template = ?12,
          story_royalty_policy = ?13,
          story_royalty_policy_id = ?14,
          story_derivative_parent_ip_ids_json = ?15,
          story_derivative_registered_at = ?16,
          story_revenue_token = ?17,
          story_royalty_registration_status = ?18,
          story_publish_tx_ref = ?19,
          story_asset_version_id = ?20,
          story_cdr_vault_uuid = ?21,
          story_namespace = ?22,
          story_entitlement_token_id = ?23,
          story_read_condition = ?24,
          story_write_condition = ?25,
          license_preset = ?26,
          commercial_rev_share_pct = ?27,
          updated_at = ?28
      WHERE community_id = ?1
        AND asset_id = ?2
    `,
    args: [
      input.communityId,
      asset.asset_id,
      publicationStatus,
      storyStatus,
      storyError,
      storyIpId,
      storyIpNftContract,
      storyIpNftTokenId,
      ipRoyaltyVault,
      storyPublishModel,
      storyLicenseTermsId,
      storyLicenseTemplate,
      storyRoyaltyPolicy,
      storyRoyaltyPolicyId,
      storyDerivativeParentIpIdsJson,
      storyDerivativeRegisteredAt,
      storyRevenueToken,
      storyRoyaltyRegistrationStatus,
      storyPublishTxRef,
      storyAssetVersionId,
      storyCdrVaultUuid,
      storyNamespace,
      storyEntitlementTokenId,
      storyReadCondition,
      storyWriteCondition,
      effectiveLicensePreset,
      effectiveCommercialRevSharePct,
      updatedAt,
    ],
  })
  return {
    ...asset,
    commercial_rev_share_pct: effectiveCommercialRevSharePct,
    license_preset: effectiveLicensePreset,
    publication_status: publicationStatus,
    story_asset_version_id: storyAssetVersionId,
    story_cdr_vault_uuid: storyCdrVaultUuid,
    story_derivative_parent_ip_ids_json: storyDerivativeParentIpIdsJson,
    story_derivative_registered_at: storyDerivativeRegisteredAt,
    story_entitlement_token_id: storyEntitlementTokenId,
    story_error: storyError,
    story_ip_id: storyIpId,
    story_ip_nft_contract: storyIpNftContract,
    story_ip_nft_token_id: storyIpNftTokenId,
    story_license_template: storyLicenseTemplate,
    story_license_terms_id: storyLicenseTermsId,
    story_namespace: storyNamespace,
    story_publish_model: storyPublishModel,
    story_publish_tx_ref: storyPublishTxRef,
    story_read_condition: storyReadCondition,
    story_revenue_token: storyRevenueToken,
    story_royalty_policy: storyRoyaltyPolicy,
    story_royalty_policy_id: storyRoyaltyPolicyId,
    story_royalty_registration_status: storyRoyaltyRegistrationStatus,
    story_status: storyStatus,
    story_write_condition: storyWriteCondition,
    updated_at: updatedAt,
  }
}

export function shouldPrepareLockedDeliveryAsync(env: Pick<Env, "ENVIRONMENT" | "STORY_LOCKED_DELIVERY_ASYNC">): boolean {
  return envFlag(env.STORY_LOCKED_DELIVERY_ASYNC, !isLocalEnvironment(env.ENVIRONMENT))
}

function hasRecoverableCompletedLockedDelivery(input: {
  asset: AssetRow
  requireStoryRoyaltyRegistration: boolean
}): boolean {
  const asset = input.asset
  const hasDeliveryMetadata = Boolean(
    asset.story_asset_version_id?.trim()
      && asset.story_cdr_vault_uuid
      && asset.story_cdr_vault_uuid > 0
      && asset.story_namespace?.trim()
      && asset.story_entitlement_token_id?.trim()
      && asset.story_read_condition?.trim()
      && asset.story_write_condition?.trim()
      && asset.locked_delivery_ref?.trim()
      && asset.locked_delivery_storage_ref?.trim()
      && asset.locked_delivery_secret_json?.trim()
      && asset.story_publish_tx_ref?.trim(),
  )
  if (!hasDeliveryMetadata) {
    return false
  }
  if (!input.requireStoryRoyaltyRegistration) {
    return true
  }
  return asset.story_royalty_registration_status === "registered" && Boolean(asset.story_ip_id?.trim())
}

async function markRecoverableLockedDeliveryReady(input: {
  client: Pick<Client, "execute">
  communityId: string
  asset: AssetRow
}): Promise<Asset> {
  await input.client.execute({
    sql: `
      UPDATE assets
      SET publication_status = 'story_published',
          story_status = 'published',
          story_error = NULL,
          locked_delivery_status = 'ready',
          locked_delivery_error = NULL,
          updated_at = ?3
      WHERE community_id = ?1
        AND asset_id = ?2
    `,
    args: [input.communityId, input.asset.asset_id, nowIso()],
  })
  const repaired = await getAssetRow(input.client, input.communityId, input.asset.asset_id)
  return serializeAsset(repaired ?? input.asset)
}

function buildPublicAssetContentPath(communityId: string, assetId: string): string {
  return `/public-communities/${encodeURIComponent(`com_${communityId}`)}/assets/${encodeURIComponent(`asset_${assetId}`)}/content`
}

function isProjectableStoryRegisteredAsset(input: {
  assetKind: Asset["asset_kind"]
  publicationStatus: Asset["publication_status"]
  storyStatus: Asset["story_status"]
  storyRoyaltyRegistrationStatus: "none" | "pending" | "registered" | "failed"
  storyIpId: string | null
  storyLicenseTermsId: string | null
}): input is typeof input & {
  assetKind: "song_audio" | "video_file"
  storyIpId: string
  storyLicenseTermsId: string
} {
  return isStoryRoyaltyAssetKind(input.assetKind)
    && input.publicationStatus === "story_published"
    && input.storyStatus === "published"
    && input.storyRoyaltyRegistrationStatus === "registered"
    && Boolean(input.storyIpId?.trim())
    && Boolean(input.storyLicenseTermsId?.trim())
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

export async function createAssetForPost(input: {
  env: Env
  client: Pick<Client, "execute" | "transaction">
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
  royaltyAllocations?: RoyaltyAllocationRequest[] | null
  requireStoryRoyaltyRegistration?: boolean
  userRepository: UserRepository
}): Promise<Asset> {
  if (!input.post.asset_id?.trim()) {
    throw badRequestError("Post is missing asset_id")
  }
  const existing = await getAssetRow(input.client, input.communityId, input.post.asset_id)
  if (existing) {
    const existingRequiresStoryRoyaltyRegistration = shouldAttemptStoryRoyaltyRegistration({
      assetKind: existing.asset_kind,
      rightsBasis: existing.rights_basis,
      hasSongBundle: Boolean(existing.song_artifact_bundle_id),
    })
    if (
      input.requireStoryRoyaltyRegistration
      && existingRequiresStoryRoyaltyRegistration
      && !hasCompleteStoryRoyaltyRegistration(existing)
    ) {
      const registered = await retryExistingStoryRoyaltyRegistration({
        env: input.env,
        client: input.client,
        communityId: input.communityId,
        post: input.post,
        asset: existing,
        bundle: input.bundle ?? null,
        userRepository: input.userRepository,
      })
      return serializeAsset(registered)
    }
    if (input.royaltyAllocations && input.royaltyAllocations.length > 0) {
      await assertExistingAssetAllocationMatches({
        client: input.client,
        communityId: input.communityId,
        assetId: input.post.asset_id,
        requestedFingerprint: await fingerprintForRequest(
          input.royaltyAllocations,
          resolveAllocationChainId(input.env),
        ),
      })
    }
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
  let ipRoyaltyVault: string | null = null
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
  const requestedAllocations = input.royaltyAllocations ?? []
  let royaltyAllocationStatus: "none" | "draft" | "verification_pending" = "none"
  let royaltyAllocationFingerprint: string | null = null
  let allocationStatements: InStatement[] = []
  let storyRoyaltySharesForRegistration: ReturnType<typeof buildStoryRoyaltySharesFromAllocationRows> | null = null
  let storyRoyaltyAllocationDistributionTxHash: string | null = null
  if (requestedAllocations.length > 0) {
    const allocationChainId = resolveAllocationChainId(input.env)
    const fingerprint = await fingerprintForRequest(requestedAllocations, allocationChainId)
    const creator = await resolveCreatorWalletSnapshot({
      userRepository: input.userRepository,
      userId: input.post.author_user_id ?? "",
    })
    const allocationRows = buildAllocationRows({
      assetId: input.post.asset_id,
      communityId: input.communityId,
      creatorUserId: input.post.author_user_id ?? "",
      allocations: requestedAllocations,
      fingerprint,
      creator,
      chainId: allocationChainId,
      now: createdAt,
      newId: () => `rya_${crypto.randomUUID()}`,
    })
    storyRoyaltySharesForRegistration = buildStoryRoyaltySharesFromAllocationRows(allocationRows)
    allocationStatements = buildAllocationInsertStatements(allocationRows)
    royaltyAllocationStatus = "draft"
    royaltyAllocationFingerprint = fingerprint
  }
  const lockedDeliveryAsync = (input.post.access_mode ?? "public") === "locked"
    && shouldPrepareLockedDeliveryAsync(input.env)

  if ((input.post.access_mode ?? "public") === "locked") {
    if (lockedDeliveryAsync) {
      storyStatus = "requested"
      publicationStatus = "story_requested"
      lockedDeliveryStatus = "requested"
      lockedDeliveryError = null
    } else {
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
  }

  if (!lockedDeliveryAsync) {
    try {
      const shouldRunRoyaltyRegistration = shouldRegisterRoyalty && storyRoyaltyRegistrationStatus !== "registered"
      const reusableOriginalRegistration = shouldRunRoyaltyRegistration
        && requestedAllocations.length === 0
        && (input.post.rights_basis ?? "none") === "original"
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
        ipRoyaltyVault = reusableOriginalRegistration.ip_royalty_vault
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
            royaltyShares: storyRoyaltySharesForRegistration,
          })
        : null
      if (royaltyRegistration) {
        storyIpId = royaltyRegistration.storyIpId
        storyIpNftContract = royaltyRegistration.storyIpNftContract
        storyIpNftTokenId = royaltyRegistration.storyIpNftTokenId
        ipRoyaltyVault = royaltyRegistration.ipRoyaltyVault ?? null
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
        if ((input.post.rights_basis ?? "none") === "derivative" && !royaltyRegistration.storyLicenseTermsId) {
          effectiveLicensePreset = null
          effectiveCommercialRevSharePct = null
        }
        if (storyRoyaltySharesForRegistration && storyRoyaltySharesForRegistration.length > 0) {
          storyRoyaltyAllocationDistributionTxHash = royaltyRegistration.royaltyDistributionTxHash
          royaltyAllocationStatus = "verification_pending"
        }
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
  }

  if (shouldRegisterRoyalty && storyRoyaltyRegistrationStatus === "failed" && input.requireStoryRoyaltyRegistration) {
    const sanitizedStoryError = sanitizeStoryRegistrationFailure(storyError)
    const storyErrorClass = classifyStoryRegistrationFailure(storyError)
    console.error("[commerce] required Story registration failed", {
      community_id: input.communityId,
      post_id: input.post.post_id,
      asset_id: input.post.asset_id,
      asset_kind: input.assetKind,
      rights_basis: input.post.rights_basis ?? "none",
      primary_content_hash: resolvedPrimaryContentHash,
      upstream_asset_ref_count: input.post.upstream_asset_refs?.length ?? 0,
      story_error_class: storyErrorClass,
      story_error: sanitizedStoryError, // raw detail — server logs only, never returned to the client
    })
    // Detail is serialized into the HTTP response (errors.ts errorResponse), so it
    // must not carry raw SDK/contract/RPC text — only the coarse class.
    throw providerUnavailable(
      storyRegistrationFailureMessage(storyError),
      {
        reason: "story_royalty_registration_failed",
        community_id: input.communityId,
        post_id: input.post.post_id,
        asset_id: input.post.asset_id,
        asset_kind: input.assetKind,
        rights_basis: input.post.rights_basis ?? "none",
        primary_content_hash: resolvedPrimaryContentHash,
        upstream_asset_ref_count: input.post.upstream_asset_refs?.length ?? 0,
        story_error_class: storyErrorClass,
      },
      isStoryRegistrationFailureRetryable(storyErrorClass),
    )
  }

  const assetInsert: InStatement = {
    sql: `
      INSERT INTO assets (
        asset_id, community_id, source_post_id, display_title, song_artifact_bundle_id, creator_user_id, asset_kind,
        rights_basis, access_mode, license_preset, commercial_rev_share_pct,
        primary_content_ref, primary_content_hash, publication_status,
        story_status, story_error, story_ip_id, story_ip_nft_contract, story_ip_nft_token_id,
        ip_royalty_vault, story_publish_model, story_license_terms_id, story_license_template, story_royalty_policy,
        story_royalty_policy_id, story_derivative_parent_ip_ids_json, story_derivative_registered_at,
        story_revenue_token, story_royalty_registration_status, locked_delivery_status, locked_delivery_ref,
        locked_delivery_error, created_at, updated_at, story_publish_tx_ref, story_asset_version_id,
        story_cdr_vault_uuid, story_namespace, story_entitlement_token_id, story_read_condition,
        story_write_condition, locked_delivery_storage_ref, locked_delivery_secret_json,
        royalty_allocation_status, royalty_allocation_version, royalty_allocation_fingerprint,
        royalty_allocation_projection_synced
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7,
        ?8, ?9, ?10, ?11,
        ?12, ?13, ?14,
        ?15, ?16, ?17, ?18, ?19,
        ?20, ?21, ?22, ?23, ?24,
        ?25, ?26, ?27, ?28, ?29,
        ?30, ?31, ?32, ?33, ?33,
        ?34, ?35, ?36, ?37, ?38,
        ?39, ?40, ?41, ?42,
        ?43, ?44, ?45, ?46
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
      ipRoyaltyVault,
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
      royaltyAllocationStatus,
      ROYALTY_ALLOCATION_VERSION,
      royaltyAllocationFingerprint,
      royaltyAllocationStatus === "none" ? 1 : 0,
    ],
  }
  if (allocationStatements.length > 0) {
    await persistAssetWithAllocations({
      client: input.client,
      assetInsert,
      allocationStatements,
    })
  } else {
    await input.client.execute(assetInsert)
  }
  if (royaltyAllocationStatus === "verification_pending") {
    await markStoryRoyaltyAllocationRegistrationPendingVerification({
      client: input.client,
      communityId: input.communityId,
      assetId: input.post.asset_id,
      ipRoyaltyVault,
      distributionTxHash: storyRoyaltyAllocationDistributionTxHash,
      registeredAt: nowIso(),
    })
  }
  const projectionCandidate = {
    assetKind: input.assetKind,
    publicationStatus,
    storyStatus,
    storyRoyaltyRegistrationStatus,
    storyIpId,
    storyLicenseTermsId,
  }
  if (isProjectableStoryRegisteredAsset(projectionCandidate)) {
    try {
      await upsertStoryRegisteredAssetProjection({
        env: input.env,
        projection: {
          communityId: input.communityId,
          assetId: input.post.asset_id,
          displayTitle: input.displayTitle?.trim() || input.post.title?.trim() || null,
          creatorUserId: input.post.author_user_id ?? "",
          assetKind: projectionCandidate.assetKind,
          licensePreset: effectiveLicensePreset,
          commercialRevSharePct: effectiveCommercialRevSharePct,
          storyIpId: projectionCandidate.storyIpId,
          storyLicenseTermsId: projectionCandidate.storyLicenseTermsId,
          sourcePostId: input.post.post_id,
          sourcePostStatus: input.post.status ?? "published",
          sourceUpdatedAt: input.post.updated_at ?? createdAt,
          createdAt,
        },
      })
    } catch (error) {
      logPipelineInfo("[commerce] Story registered asset projection upsert failed", {
        level: "warn",
        community_id: input.communityId,
        post_id: input.post.post_id,
        asset_id: input.post.asset_id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (isProjectableStoryRegisteredAsset(projectionCandidate)) {
    await syncStoryRoyaltyAllocationProjectionSafely({
      env: input.env,
      client: input.client,
      communityId: input.communityId,
      postId: input.post.post_id,
      assetId: input.post.asset_id,
      sourceUpdatedAt: input.post.updated_at ?? createdAt,
    })
  }
  const asset = await getAssetRow(input.client, input.communityId, input.post.asset_id)
  if (!asset) {
    throw notFoundError("Asset not found")
  }
  return serializeAsset(asset)
}

export async function createSongAssetForPost(input: {
  env: Env
  client: Pick<Client, "execute" | "transaction">
  communityId: string
  post: Post
  bundle: SongArtifactBundle
  licensePreset: StoryLicensePreset | null
  commercialRevSharePct: number | null
  royaltyAllocations?: RoyaltyAllocationRequest[] | null
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
    royaltyAllocations: input.royaltyAllocations ?? null,
    requireStoryRoyaltyRegistration: input.requireStoryRoyaltyRegistration,
    userRepository: input.userRepository,
  })
}

export async function prepareRequestedLockedAssetDelivery(input: {
  env: Env
  client: Pick<Client, "execute">
  communityId: string
  assetId: string
  userRepository: UserRepository
  markFailureAsTerminal?: boolean
}): Promise<Asset> {
  const asset = await getAssetRow(input.client, input.communityId, input.assetId)
  if (!asset) {
    throw notFoundError("Asset not found")
  }
  if (asset.access_mode !== "locked") {
    return serializeAsset(asset)
  }
  if (asset.locked_delivery_status === "ready") {
    return serializeAsset(asset)
  }
  const requiresStoryRoyaltyRegistration = shouldAttemptStoryRoyaltyRegistration({
    assetKind: asset.asset_kind,
    rightsBasis: asset.rights_basis,
    hasSongBundle: Boolean(asset.song_artifact_bundle_id),
  })
  if (
    hasRecoverableCompletedLockedDelivery({
      asset,
      requireStoryRoyaltyRegistration: requiresStoryRoyaltyRegistration,
    })
  ) {
    return await markRecoverableLockedDeliveryReady({
      client: input.client,
      communityId: input.communityId,
      asset,
    })
  }

  const post = await getPostById(input.client as Client, asset.source_post_id)
  if (!post) {
    throw notFoundError("Asset source post not found")
  }

  const controlPlaneClient = getControlPlaneClient(input.env)
  const artifactKind: SongArtifactUpload["artifact_kind"] = asset.asset_kind === "video_file"
    ? "primary_video"
    : "primary_audio"
  const upload = await findUploadedSongArtifactByStorageRef({
    client: controlPlaneClient,
    communityId: input.communityId,
    storageRef: asset.primary_content_ref,
    artifactKind,
  })
  if (!upload) {
    throw badRequestError("Primary asset upload is missing")
  }
  const resolvedPrimaryContentHash = (asset.primary_content_hash?.trim() || `0x${await sha256Hex(asset.primary_content_ref)}`) as `0x${string}`
  const bundle = asset.song_artifact_bundle_id
    ? await getSongArtifactBundle(
        controlPlaneClient,
        input.communityId,
        asset.song_artifact_bundle_id.replace(/^sab_/, ""),
      )
    : null
  const creatorWalletAddress = await resolvePrimaryWalletAddress({
    env: input.env,
    userRepository: input.userRepository,
    userId: asset.creator_user_id,
  })
  let storyError: string | null = null
  let storyStatus: Asset["story_status"] = "requested"
  let publicationStatus: Asset["publication_status"] = "story_requested"
  let storyIpId: string | null = null
  let storyIpNftContract: string | null = null
  let storyIpNftTokenId: string | null = null
  let ipRoyaltyVault: string | null = asset.ip_royalty_vault
  let storyPublishModel: "pirate_v1" | "story_ip_v1" = asset.story_publish_model
  let storyLicenseTermsId: string | null = asset.story_license_terms_id
  let storyLicenseTemplate: string | null = asset.story_license_template
  let storyRoyaltyPolicy: string | null = asset.story_royalty_policy
  let storyRoyaltyPolicyId: string | null = asset.story_royalty_policy_id
  let storyDerivativeParentIpIdsJson: string | null = asset.story_derivative_parent_ip_ids_json
  let storyDerivativeRegisteredAt: string | null = asset.story_derivative_registered_at
  let storyRevenueToken: string | null = asset.story_revenue_token
  let storyRoyaltyRegistrationStatus = asset.story_royalty_registration_status
  let storyPublishTxRef: string | null = asset.story_publish_tx_ref
  let storyAssetVersionId: string | null = asset.story_asset_version_id
  let storyCdrVaultUuid: number | null = asset.story_cdr_vault_uuid
  let storyNamespace: string | null = asset.story_namespace
  let storyEntitlementTokenId: string | null = asset.story_entitlement_token_id
  let storyReadCondition: string | null = asset.story_read_condition
  let storyWriteCondition: string | null = asset.story_write_condition
  let lockedDeliveryRef: string | null = asset.locked_delivery_ref
  let lockedDeliveryStorageRef: string | null = asset.locked_delivery_storage_ref
  let lockedDeliveryMetadataJson: string | null = asset.locked_delivery_secret_json
  let effectiveLicensePreset = asset.license_preset as StoryLicensePreset | null
  let effectiveCommercialRevSharePct = asset.commercial_rev_share_pct

  try {
    const lockedDelivery = await prepareLockedAssetDelivery({
      env: input.env,
      communityId: input.communityId,
      assetId: asset.asset_id,
      creatorWalletAddress,
      storageRef: asset.primary_content_ref,
      mimeType: upload.mime_type,
      contentHash: asset.primary_content_hash,
      artifactKind,
      bundleId: asset.song_artifact_bundle_id,
      rightsBasis: asset.rights_basis,
      upstreamAssetRefs: post.upstream_asset_refs ?? null,
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
    lockedDeliveryRef = lockedDelivery.lockedDeliveryRef
    lockedDeliveryStorageRef = lockedDelivery.lockedDeliveryStorageRef
    lockedDeliveryMetadataJson = lockedDelivery.lockedDeliveryMetadataJson
  } catch (error) {
    const lockedDeliveryError = error instanceof Error ? error.message : String(error)
    const terminalFailure = input.markFailureAsTerminal ?? true
    await input.client.execute({
      sql: `
        UPDATE assets
        SET story_status = ?3,
            story_error = ?4,
            locked_delivery_status = ?5,
            locked_delivery_error = ?6,
            updated_at = ?7
        WHERE community_id = ?1
          AND asset_id = ?2
      `,
      args: [
        input.communityId,
        asset.asset_id,
        terminalFailure ? "failed" : "requested",
        lockedDeliveryError,
        terminalFailure ? "failed" : "requested",
        lockedDeliveryError,
        nowIso(),
      ],
    })
    throw error
  }

  const shouldRegisterRoyalty = shouldAttemptStoryRoyaltyRegistration({
    assetKind: asset.asset_kind,
    rightsBasis: asset.rights_basis,
    hasSongBundle: Boolean(bundle),
  })
  try {
    const shouldRunRoyaltyRegistration = shouldRegisterRoyalty && storyRoyaltyRegistrationStatus !== "registered"
      const reusableOriginalRegistration = shouldRunRoyaltyRegistration
        && asset.rights_basis === "original"
        && asset.royalty_allocation_status === "none"
        ? await findReusableRegisteredOriginalStoryAssetByContent({
          client: input.client,
          communityId: input.communityId,
          creatorUserId: asset.creator_user_id,
          assetKind: asset.asset_kind,
          primaryContentHash: resolvedPrimaryContentHash,
        })
      : null

    if (reusableOriginalRegistration) {
      storyIpId = reusableOriginalRegistration.story_ip_id
      storyIpNftContract = reusableOriginalRegistration.story_ip_nft_contract
      storyIpNftTokenId = reusableOriginalRegistration.story_ip_nft_token_id
      ipRoyaltyVault = reusableOriginalRegistration.ip_royalty_vault
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

    const royaltyRegistration = shouldRunRoyaltyRegistration && !reusableOriginalRegistration
      ? await maybeRegisterStoryRoyaltyForAsset({
          env: input.env,
          client: input.client,
          communityId: input.communityId,
          assetId: asset.asset_id,
          creatorWalletAddress,
          title: post.title ?? null,
          rightsBasis: asset.rights_basis,
          licensePreset: effectiveLicensePreset,
          commercialRevSharePct: effectiveCommercialRevSharePct,
          upstreamAssetRefs: post.upstream_asset_refs ?? null,
          assetKind: asset.asset_kind,
          bundle,
          primaryContentHash: resolvedPrimaryContentHash,
        })
      : null
    if (royaltyRegistration) {
      storyIpId = royaltyRegistration.storyIpId
      storyIpNftContract = royaltyRegistration.storyIpNftContract
      storyIpNftTokenId = royaltyRegistration.storyIpNftTokenId
      ipRoyaltyVault = royaltyRegistration.ipRoyaltyVault ?? null
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
      if (asset.rights_basis === "derivative" && !royaltyRegistration.storyLicenseTermsId) {
        effectiveLicensePreset = null
        effectiveCommercialRevSharePct = null
      }
      await markStoryRoyaltyAllocationRegistrationPendingVerification({
        client: input.client,
        communityId: input.communityId,
        assetId: asset.asset_id,
        ipRoyaltyVault,
        distributionTxHash: royaltyRegistration.royaltyDistributionTxHash,
        registeredAt: nowIso(),
      })
    } else if (shouldRegisterRoyalty && storyRoyaltyRegistrationStatus === "pending") {
      const registrationError = isStoryRoyaltyRegistrationConfigured(input.env)
        ? "story_royalty_registration_unavailable"
        : "story_royalty_config_missing"
      storyRoyaltyRegistrationStatus = "failed"
      storyError = `royalty_registration_failed:${registrationError}`
    }
  } catch (error) {
    const registrationError = error instanceof Error ? error.message : String(error)
    storyRoyaltyRegistrationStatus = "failed"
    storyError = `royalty_registration_failed:${registrationError}`
  }

  if (shouldRegisterRoyalty && storyRoyaltyRegistrationStatus === "failed") {
    const sanitizedStoryError = sanitizeStoryRegistrationFailure(storyError)
    const storyErrorClass = classifyStoryRegistrationFailure(storyError)
    await input.client.execute({
      sql: `
        UPDATE assets
        SET story_status = 'failed',
            story_error = ?3,
            story_royalty_registration_status = 'failed',
            locked_delivery_status = 'failed',
            locked_delivery_error = ?3,
            updated_at = ?4
        WHERE community_id = ?1
          AND asset_id = ?2
      `,
      args: [input.communityId, asset.asset_id, sanitizedStoryError, nowIso()],
    })
    console.error("[commerce] required Story registration failed (locked delivery)", {
      community_id: input.communityId,
      asset_id: asset.asset_id,
      asset_kind: asset.asset_kind,
      rights_basis: asset.rights_basis,
      story_error_class: storyErrorClass,
      story_error: sanitizedStoryError, // raw detail — server logs only, never returned to the client
    })
    // Detail is serialized into the HTTP response (errors.ts errorResponse), so it
    // must not carry raw SDK/contract/RPC text — only the coarse class.
    throw providerUnavailable(
      storyRegistrationFailureMessage(storyError),
      {
        reason: "story_royalty_registration_failed",
        community_id: input.communityId,
        asset_id: asset.asset_id,
        asset_kind: asset.asset_kind,
        rights_basis: asset.rights_basis,
        primary_content_hash: resolvedPrimaryContentHash,
        upstream_asset_ref_count: post.upstream_asset_refs?.length ?? 0,
        story_error_class: storyErrorClass,
      },
      isStoryRegistrationFailureRetryable(storyErrorClass),
    )
  }

  const updatedAt = nowIso()
  await input.client.execute({
    sql: `
      UPDATE assets
      SET publication_status = ?3,
          story_status = ?4,
          story_error = ?5,
          story_ip_id = ?6,
          story_ip_nft_contract = ?7,
          story_ip_nft_token_id = ?8,
          ip_royalty_vault = ?9,
          story_publish_model = ?10,
          story_license_terms_id = ?11,
          story_license_template = ?12,
          story_royalty_policy = ?13,
          story_royalty_policy_id = ?14,
          story_derivative_parent_ip_ids_json = ?15,
          story_derivative_registered_at = ?16,
          story_revenue_token = ?17,
          story_royalty_registration_status = ?18,
          story_publish_tx_ref = ?19,
          story_asset_version_id = ?20,
          story_cdr_vault_uuid = ?21,
          story_namespace = ?22,
          story_entitlement_token_id = ?23,
          story_read_condition = ?24,
          story_write_condition = ?25,
          locked_delivery_status = 'ready',
          locked_delivery_ref = ?26,
          locked_delivery_error = NULL,
          locked_delivery_storage_ref = ?27,
          locked_delivery_secret_json = ?28,
          license_preset = ?29,
          commercial_rev_share_pct = ?30,
          updated_at = ?31
      WHERE community_id = ?1
        AND asset_id = ?2
    `,
    args: [
      input.communityId,
      asset.asset_id,
      publicationStatus,
      storyStatus,
      storyError,
      storyIpId,
      storyIpNftContract,
      storyIpNftTokenId,
      ipRoyaltyVault,
      storyPublishModel,
      storyLicenseTermsId,
      storyLicenseTemplate,
      storyRoyaltyPolicy,
      storyRoyaltyPolicyId,
      storyDerivativeParentIpIdsJson,
      storyDerivativeRegisteredAt,
      storyRevenueToken,
      storyRoyaltyRegistrationStatus,
      storyPublishTxRef,
      storyAssetVersionId,
      storyCdrVaultUuid,
      storyNamespace,
      storyEntitlementTokenId,
      storyReadCondition,
      storyWriteCondition,
      lockedDeliveryRef,
      lockedDeliveryStorageRef,
      lockedDeliveryMetadataJson,
      effectiveLicensePreset,
      effectiveCommercialRevSharePct,
      updatedAt,
    ],
  })

  const projectionCandidate = {
    assetKind: asset.asset_kind,
    publicationStatus,
    storyStatus,
    storyRoyaltyRegistrationStatus,
    storyIpId,
    storyLicenseTermsId,
  }
  if (isProjectableStoryRegisteredAsset(projectionCandidate)) {
    try {
      await upsertStoryRegisteredAssetProjection({
        env: input.env,
        projection: {
          communityId: input.communityId,
          assetId: asset.asset_id,
          displayTitle: asset.display_title ?? post.title ?? null,
          creatorUserId: asset.creator_user_id,
          assetKind: projectionCandidate.assetKind,
          licensePreset: effectiveLicensePreset,
          commercialRevSharePct: effectiveCommercialRevSharePct,
          storyIpId: projectionCandidate.storyIpId,
          storyLicenseTermsId: projectionCandidate.storyLicenseTermsId,
          sourcePostId: post.post_id,
          sourcePostStatus: post.status ?? "published",
          sourceUpdatedAt: post.updated_at ?? updatedAt,
          createdAt: updatedAt,
        },
      })
    } catch (error) {
      logPipelineInfo("[commerce] Story registered asset projection upsert failed", {
        level: "warn",
        community_id: input.communityId,
        post_id: post.post_id,
        asset_id: asset.asset_id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  if (isProjectableStoryRegisteredAsset(projectionCandidate)) {
    await syncStoryRoyaltyAllocationProjectionSafely({
      env: input.env,
      client: input.client,
      communityId: input.communityId,
      postId: post.post_id,
      assetId: asset.asset_id,
      sourceUpdatedAt: post.updated_at ?? updatedAt,
    })
  }

  const updated = await getAssetRow(input.client, input.communityId, asset.asset_id)
  if (!updated) {
    throw notFoundError("Asset not found")
  }
  return serializeAsset(updated)
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
  return await listDerivativeSources({
    ...input,
    scope: "community",
  })
}

export async function listDerivativeSources(input: {
  env: Env
  userId: string
  scope: DerivativeSourceScope
  communityId: string
  kind?: DerivativeSourceKind | null
  query?: string | null
  limit: number
  communityRepository: CommunityDatabaseBindingRepository
  profileRepository: ProfileRepository
}): Promise<DerivativeSourceListResponse> {
  let rows: DerivativeSourceRow[]
  if (input.scope === "global") {
    await requireDerivativeSourceComposerCommunity({
      env: input.env,
      userId: input.userId,
      communityId: input.communityId,
      communityRepository: input.communityRepository,
    })
    rows = await listGlobalDerivativeSourceRows({
      env: input.env,
      kind: input.kind,
      query: input.query,
      limit: input.limit,
    })
  } else {
    const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
    try {
      await requireCommunityMember(db.client, input.communityId, input.userId)
      rows = await listDerivativeSourceRows({
        client: db.client,
        communityId: input.communityId,
        kind: input.kind,
        query: input.query,
        limit: input.limit,
      })
    } finally {
      db.close()
    }
  }

  return await derivativeSourceRowsToResponse({
    rows,
    profileRepository: input.profileRepository,
  })
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

export * from "./policy-service"
export * from "./listing-service"
export * from "./quote-service"
export * from "./settlement-service"
