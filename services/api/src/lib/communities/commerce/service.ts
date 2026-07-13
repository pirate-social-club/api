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
  resolveRoyaltyAllocationRequests,
  tryResolveCreatorWalletSnapshot,
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
  type StoryRoyaltyRegistrationResult,
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
import {
  assertAssetNotBlockedByRightsHold,
  assertAssetNotRightsHeld,
  blockedRightsHoldMessage,
} from "./rights-hold-gates"
import type { BuyerIdentity } from "./buyer-identity"
import { getControlPlaneClient } from "../../runtime-deps"
import type { CommunityJobCheckpoint } from "../jobs/store"
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

type LockedDeliveryProgressReporter = (
  checkpoint: CommunityJobCheckpoint,
  details?: Record<string, unknown> | null,
) => Promise<void>

function resolveLockedDeliveryHeartbeatIntervalMs(env: Pick<Env, "COMMUNITY_JOB_HEARTBEAT_INTERVAL_MS">): number {
  const raw = String(env.COMMUNITY_JOB_HEARTBEAT_INTERVAL_MS || "").trim()
  const parsed = raw ? Number(raw) : 30_000
  return Number.isInteger(parsed) && parsed >= 5_000 && parsed <= 120_000 ? parsed : 30_000
}

async function recordLockedDeliveryProgress(
  progress: LockedDeliveryProgressReporter | null | undefined,
  checkpoint: CommunityJobCheckpoint,
  details?: Record<string, unknown> | null,
): Promise<void> {
  await progress?.(checkpoint, details ?? null)
}

async function withLockedDeliveryProgressHeartbeat<T>(input: {
  env: Env
  progress?: LockedDeliveryProgressReporter | null
  checkpoint: CommunityJobCheckpoint
  heartbeatCheckpoint?: CommunityJobCheckpoint
  details?: Record<string, unknown> | null
  operation: () => Promise<T>
}): Promise<T> {
  await recordLockedDeliveryProgress(input.progress, input.checkpoint, input.details ?? null)
  const intervalMs = resolveLockedDeliveryHeartbeatIntervalMs(input.env)
  let timer: ReturnType<typeof setInterval> | null = null
  if (input.progress) {
    timer = setInterval(() => {
      void recordLockedDeliveryProgress(
        input.progress,
        input.heartbeatCheckpoint ?? input.checkpoint,
        input.details ?? null,
      ).catch((error) => {
        console.warn("[community-job] locked delivery heartbeat failed", {
          checkpoint: input.heartbeatCheckpoint ?? input.checkpoint,
          error: error instanceof Error ? error.message : String(error),
        })
      })
    }, intervalMs)
  }
  try {
    return await input.operation()
  } finally {
    if (timer) clearInterval(timer)
  }
}

async function syncStoryRoyaltyAllocationProjectionSafely(input: {
  env: Env
  client: Pick<Client, "execute">
  communityId: string
  postId: string
  assetId: string
  sourceUpdatedAt?: string | null
  required?: boolean
}): Promise<void> {
  const maxAttempts = input.required ? 3 : 1
  let lastError: unknown = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await syncStoryRoyaltyAllocationProjectionForAsset(input)
      if (input.required && result.projectedRows === 0) {
        throw new Error("royalty_allocation_projection_rows_missing")
      }
      if (result.projectedRows > 0) {
        logPipelineInfo("[commerce] Story royalty allocation projection synced", {
          community_id: input.communityId,
          post_id: input.postId,
          asset_id: input.assetId,
          projected_rows: result.projectedRows,
          attempt,
        })
      }
      return
    } catch (error) {
      lastError = error
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 250))
      }
    }
  }
  logPipelineInfo("[commerce] Story royalty allocation projection sync failed", {
    level: "warn",
    community_id: input.communityId,
    post_id: input.postId,
    asset_id: input.assetId,
    attempts: maxAttempts,
    error: lastError instanceof Error ? lastError.message : String(lastError),
  })
  if (input.required) throw lastError
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

type StoryRegistrationFieldState = {
  storyIpId: string | null
  storyIpNftContract: string | null
  storyIpNftTokenId: string | null
  ipRoyaltyVault: string | null
  storyPublishModel: "pirate_v1" | "story_ip_v1"
  storyLicenseTermsId: string | null
  storyLicenseTemplate: string | null
  storyRoyaltyPolicy: string | null
  storyRoyaltyPolicyId: string | null
  storyDerivativeParentIpIdsJson: string | null
  storyDerivativeRegisteredAt: string | null
  storyRevenueToken: string | null
  storyRoyaltyRegistrationStatus: AssetRow["story_royalty_registration_status"]
  storyPublishTxRef: string | null
  storyAssetVersionId: string | null
  storyCdrVaultUuid: number | null
  storyNamespace: string | null
  storyEntitlementTokenId: string | null
  storyReadCondition: string | null
  storyWriteCondition: string | null
  effectiveLicensePreset: StoryLicensePreset | null
  effectiveCommercialRevSharePct: number | null
}

function storyRegistrationFieldStateFromAsset(asset: AssetRow, overrides: Partial<StoryRegistrationFieldState> = {}): StoryRegistrationFieldState {
  return {
    storyIpId: asset.story_ip_id,
    storyIpNftContract: asset.story_ip_nft_contract,
    storyIpNftTokenId: asset.story_ip_nft_token_id,
    ipRoyaltyVault: asset.ip_royalty_vault,
    storyPublishModel: asset.story_publish_model,
    storyLicenseTermsId: asset.story_license_terms_id,
    storyLicenseTemplate: asset.story_license_template,
    storyRoyaltyPolicy: asset.story_royalty_policy,
    storyRoyaltyPolicyId: asset.story_royalty_policy_id,
    storyDerivativeParentIpIdsJson: asset.story_derivative_parent_ip_ids_json,
    storyDerivativeRegisteredAt: asset.story_derivative_registered_at,
    storyRevenueToken: asset.story_revenue_token,
    storyRoyaltyRegistrationStatus: asset.story_royalty_registration_status,
    storyPublishTxRef: asset.story_publish_tx_ref,
    storyAssetVersionId: asset.story_asset_version_id,
    storyCdrVaultUuid: asset.story_cdr_vault_uuid,
    storyNamespace: asset.story_namespace,
    storyEntitlementTokenId: asset.story_entitlement_token_id,
    storyReadCondition: asset.story_read_condition,
    storyWriteCondition: asset.story_write_condition,
    effectiveLicensePreset: asset.license_preset as StoryLicensePreset | null,
    effectiveCommercialRevSharePct: asset.commercial_rev_share_pct,
    ...overrides,
  }
}

function emptyStoryRegistrationFieldState(overrides: Partial<StoryRegistrationFieldState> = {}): StoryRegistrationFieldState {
  return {
    storyIpId: null,
    storyIpNftContract: null,
    storyIpNftTokenId: null,
    ipRoyaltyVault: null,
    storyPublishModel: "pirate_v1",
    storyLicenseTermsId: null,
    storyLicenseTemplate: null,
    storyRoyaltyPolicy: null,
    storyRoyaltyPolicyId: null,
    storyDerivativeParentIpIdsJson: null,
    storyDerivativeRegisteredAt: null,
    storyRevenueToken: null,
    storyRoyaltyRegistrationStatus: "none",
    storyPublishTxRef: null,
    storyAssetVersionId: null,
    storyCdrVaultUuid: null,
    storyNamespace: null,
    storyEntitlementTokenId: null,
    storyReadCondition: null,
    storyWriteCondition: null,
    effectiveLicensePreset: null,
    effectiveCommercialRevSharePct: null,
    ...overrides,
  }
}

function applyReusableOriginalRegistrationFields(
  state: StoryRegistrationFieldState,
  reusableOriginalRegistration: AssetRow,
) {
  state.storyIpId = reusableOriginalRegistration.story_ip_id
  state.storyIpNftContract = reusableOriginalRegistration.story_ip_nft_contract
  state.storyIpNftTokenId = reusableOriginalRegistration.story_ip_nft_token_id
  state.ipRoyaltyVault = reusableOriginalRegistration.ip_royalty_vault
  state.storyPublishModel = reusableOriginalRegistration.story_publish_model
  state.storyLicenseTermsId = reusableOriginalRegistration.story_license_terms_id
  state.storyLicenseTemplate = reusableOriginalRegistration.story_license_template
  state.storyRoyaltyPolicy = reusableOriginalRegistration.story_royalty_policy
  state.storyRoyaltyPolicyId = reusableOriginalRegistration.story_royalty_policy_id
  state.storyDerivativeParentIpIdsJson = reusableOriginalRegistration.story_derivative_parent_ip_ids_json
  state.storyDerivativeRegisteredAt = reusableOriginalRegistration.story_derivative_registered_at
  state.storyRevenueToken = reusableOriginalRegistration.story_revenue_token
  state.storyRoyaltyRegistrationStatus = "registered"
  state.storyPublishTxRef = reusableOriginalRegistration.story_publish_tx_ref
  state.storyAssetVersionId = reusableOriginalRegistration.story_asset_version_id
  state.storyCdrVaultUuid = reusableOriginalRegistration.story_cdr_vault_uuid
  state.storyNamespace = reusableOriginalRegistration.story_namespace
  state.storyEntitlementTokenId = reusableOriginalRegistration.story_entitlement_token_id
  state.storyReadCondition = reusableOriginalRegistration.story_read_condition
  state.storyWriteCondition = reusableOriginalRegistration.story_write_condition
  state.effectiveLicensePreset = reusableOriginalRegistration.license_preset as StoryLicensePreset | null
  state.effectiveCommercialRevSharePct = reusableOriginalRegistration.commercial_rev_share_pct
}

function applyRoyaltyRegistrationFields(
  state: StoryRegistrationFieldState,
  royaltyRegistration: StoryRoyaltyRegistrationResult,
) {
  state.storyIpId = royaltyRegistration.storyIpId
  state.storyIpNftContract = royaltyRegistration.storyIpNftContract
  state.storyIpNftTokenId = royaltyRegistration.storyIpNftTokenId
  state.ipRoyaltyVault = royaltyRegistration.ipRoyaltyVault ?? null
  state.storyPublishModel = "story_ip_v1"
  state.storyLicenseTermsId = royaltyRegistration.storyLicenseTermsId
  state.storyLicenseTemplate = royaltyRegistration.storyLicenseTemplate
  state.storyRoyaltyPolicy = royaltyRegistration.storyRoyaltyPolicy
  state.storyRoyaltyPolicyId = royaltyRegistration.storyRoyaltyPolicy
  state.storyDerivativeParentIpIdsJson = royaltyRegistration.storyDerivativeParentIpIds
    ? JSON.stringify(royaltyRegistration.storyDerivativeParentIpIds)
    : null
  state.storyDerivativeRegisteredAt = royaltyRegistration.storyDerivativeRegisteredAt
  state.storyRevenueToken = royaltyRegistration.storyRevenueToken
  state.storyRoyaltyRegistrationStatus = royaltyRegistration.storyRoyaltyRegistrationStatus
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
  const storyRegistration = storyRegistrationFieldStateFromAsset(asset)

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
      applyReusableOriginalRegistrationFields(storyRegistration, reusableOriginalRegistration)
      storyStatus = "published"
      publicationStatus = "story_published"
      storyError = null
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
        licensePreset: storyRegistration.effectiveLicensePreset,
        commercialRevSharePct: storyRegistration.effectiveCommercialRevSharePct,
        upstreamAssetRefs: input.post.upstream_asset_refs ?? null,
        assetKind: asset.asset_kind,
        bundle: input.bundle ?? null,
        primaryContentHash: resolvedPrimaryContentHash,
      })
      if (royaltyRegistration) {
        applyRoyaltyRegistrationFields(storyRegistration, royaltyRegistration)
        storyStatus = "published"
        publicationStatus = "story_published"
        storyError = null
        if (asset.rights_basis === "derivative" && !royaltyRegistration.storyLicenseTermsId) {
          storyRegistration.effectiveLicensePreset = null
          storyRegistration.effectiveCommercialRevSharePct = null
        }
        await markStoryRoyaltyAllocationRegistrationPendingVerification({
          client: input.client,
          communityId: input.communityId,
          assetId: asset.asset_id,
          ipRoyaltyVault: storyRegistration.ipRoyaltyVault,
          distributionTxHash: royaltyRegistration.royaltyDistributionTxHash,
          registeredAt: nowIso(),
        })
      } else {
        const registrationError = isStoryRoyaltyRegistrationConfigured(input.env)
          ? "story_royalty_registration_unavailable"
          : "story_royalty_config_missing"
        storyRegistration.storyRoyaltyRegistrationStatus = "failed"
        storyError = `royalty_registration_failed:${registrationError}`
      }
    }
  } catch (error) {
    const registrationError = error instanceof Error ? error.message : String(error)
    storyRegistration.storyRoyaltyRegistrationStatus = "failed"
    storyError = `royalty_registration_failed:${registrationError}`
  }

  if (storyRegistration.storyRoyaltyRegistrationStatus === "failed") {
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
      storyRegistration.storyIpId,
      storyRegistration.storyIpNftContract,
      storyRegistration.storyIpNftTokenId,
      storyRegistration.ipRoyaltyVault,
      storyRegistration.storyPublishModel,
      storyRegistration.storyLicenseTermsId,
      storyRegistration.storyLicenseTemplate,
      storyRegistration.storyRoyaltyPolicy,
      storyRegistration.storyRoyaltyPolicyId,
      storyRegistration.storyDerivativeParentIpIdsJson,
      storyRegistration.storyDerivativeRegisteredAt,
      storyRegistration.storyRevenueToken,
      storyRegistration.storyRoyaltyRegistrationStatus,
      storyRegistration.storyPublishTxRef,
      storyRegistration.storyAssetVersionId,
      storyRegistration.storyCdrVaultUuid,
      storyRegistration.storyNamespace,
      storyRegistration.storyEntitlementTokenId,
      storyRegistration.storyReadCondition,
      storyRegistration.storyWriteCondition,
      storyRegistration.effectiveLicensePreset,
      storyRegistration.effectiveCommercialRevSharePct,
      updatedAt,
    ],
  })
  return {
    ...asset,
    commercial_rev_share_pct: storyRegistration.effectiveCommercialRevSharePct,
    license_preset: storyRegistration.effectiveLicensePreset,
    publication_status: publicationStatus,
    story_asset_version_id: storyRegistration.storyAssetVersionId,
    story_cdr_vault_uuid: storyRegistration.storyCdrVaultUuid,
    story_derivative_parent_ip_ids_json: storyRegistration.storyDerivativeParentIpIdsJson,
    story_derivative_registered_at: storyRegistration.storyDerivativeRegisteredAt,
    story_entitlement_token_id: storyRegistration.storyEntitlementTokenId,
    story_error: storyError,
    story_ip_id: storyRegistration.storyIpId,
    story_ip_nft_contract: storyRegistration.storyIpNftContract,
    story_ip_nft_token_id: storyRegistration.storyIpNftTokenId,
    story_license_template: storyRegistration.storyLicenseTemplate,
    story_license_terms_id: storyRegistration.storyLicenseTermsId,
    story_namespace: storyRegistration.storyNamespace,
    story_publish_model: storyRegistration.storyPublishModel,
    story_publish_tx_ref: storyRegistration.storyPublishTxRef,
    story_read_condition: storyRegistration.storyReadCondition,
    story_revenue_token: storyRegistration.storyRevenueToken,
    story_royalty_policy: storyRegistration.storyRoyaltyPolicy,
    story_royalty_policy_id: storyRegistration.storyRoyaltyPolicyId,
    story_royalty_registration_status: storyRegistration.storyRoyaltyRegistrationStatus,
    story_status: storyStatus,
    story_write_condition: storyRegistration.storyWriteCondition,
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
  const shouldRegisterRoyalty = shouldAttemptStoryRoyaltyRegistration({
    assetKind: input.assetKind,
    rightsBasis: input.post.rights_basis ?? "none",
    hasSongBundle: Boolean(input.bundle),
  })
  const storyRegistration = emptyStoryRegistrationFieldState({
    storyRoyaltyRegistrationStatus: shouldRegisterRoyalty ? "pending" : "none",
    effectiveLicensePreset: input.licensePreset ?? null,
    effectiveCommercialRevSharePct: input.commercialRevSharePct ?? null,
  })
  let creatorWalletAddress: string | null = null
  const resolvedPrimaryContentHash = (input.contentHash?.trim() || `0x${await sha256Hex(input.storageRef)}`) as `0x${string}`
  const clientRequestedAllocations = input.royaltyAllocations ?? []
  let royaltyAllocationStatus: AssetRow["royalty_allocation_status"] = "none"
  let royaltyAllocationFingerprint: string | null = null
  let allocationStatements: InStatement[] = []
  let storyRoyaltySharesForRegistration: ReturnType<typeof buildStoryRoyaltySharesFromAllocationRows> | null = null
  let storyRoyaltyAllocationDistributionTxHash: string | null = null
  if (clientRequestedAllocations.length > 0) {
    const allocationChainId = resolveAllocationChainId(input.env)
    const fingerprint = await fingerprintForRequest(clientRequestedAllocations, allocationChainId)
    const creator = await resolveCreatorWalletSnapshot({
      userRepository: input.userRepository,
      userId: input.post.author_user_id ?? "",
    })
    const allocationRows = buildAllocationRows({
      assetId: input.post.asset_id,
      communityId: input.communityId,
      creatorUserId: input.post.author_user_id ?? "",
      allocations: clientRequestedAllocations,
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
  } else {
    const creator = await tryResolveCreatorWalletSnapshot({
      userRepository: input.userRepository,
      userId: input.post.author_user_id ?? "",
    })
    if (creator) {
      const allocationChainId = resolveAllocationChainId(input.env)
      const requestedAllocations = resolveRoyaltyAllocationRequests({
        requestedAllocations: null,
        creator,
      })
      const fingerprint = await fingerprintForRequest(requestedAllocations, allocationChainId)
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
    } else {
      royaltyAllocationStatus = "legacy_unverified"
    }
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
        storyRegistration.storyPublishTxRef = lockedDelivery.storyPublishTxRef
        storyRegistration.storyIpId = lockedDelivery.storyIpId
        storyRegistration.storyRoyaltyPolicyId = lockedDelivery.storyRoyaltyPolicyId
        storyRegistration.storyDerivativeParentIpIdsJson = lockedDelivery.storyDerivativeParentIpIdsJson
        if (lockedDelivery.storyRoyaltyRegistrationStatus) {
          storyRegistration.storyRoyaltyRegistrationStatus = lockedDelivery.storyRoyaltyRegistrationStatus
        }
        storyRegistration.storyAssetVersionId = lockedDelivery.storyAssetVersionId
        storyRegistration.storyCdrVaultUuid = lockedDelivery.storyCdrVaultUuid
        storyRegistration.storyNamespace = lockedDelivery.storyNamespace
        storyRegistration.storyEntitlementTokenId = lockedDelivery.storyEntitlementTokenId
        storyRegistration.storyReadCondition = lockedDelivery.storyReadCondition
        storyRegistration.storyWriteCondition = lockedDelivery.storyWriteCondition
        lockedDeliveryStatus = lockedDelivery.lockedDeliveryStatus
        lockedDeliveryRef = lockedDelivery.lockedDeliveryRef
        lockedDeliveryStorageRef = lockedDelivery.lockedDeliveryStorageRef
        lockedDeliveryMetadataJson = lockedDelivery.lockedDeliveryMetadataJson
      } catch (error) {
        storyStatus = "failed"
        storyError = error instanceof Error ? error.message : String(error)
        if ((input.post.rights_basis ?? "none") === "derivative") {
          storyRegistration.storyRoyaltyRegistrationStatus = "failed"
        }
        lockedDeliveryStatus = "failed"
        lockedDeliveryError = storyError
        throw badRequestError(`Locked delivery preparation failed: ${lockedDeliveryError}`)
      }
    }
  }

  if (!lockedDeliveryAsync) {
    try {
      const shouldRunRoyaltyRegistration = shouldRegisterRoyalty && storyRegistration.storyRoyaltyRegistrationStatus !== "registered"
      const reusableOriginalRegistration = shouldRunRoyaltyRegistration
        && clientRequestedAllocations.length === 0
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
        applyReusableOriginalRegistrationFields(storyRegistration, reusableOriginalRegistration)
        storyStatus = "published"
        publicationStatus = "story_published"
        storyError = null
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
            licensePreset: storyRegistration.effectiveLicensePreset,
            commercialRevSharePct: storyRegistration.effectiveCommercialRevSharePct,
            upstreamAssetRefs: input.post.upstream_asset_refs ?? null,
            assetKind: input.assetKind,
            bundle: input.bundle ?? null,
            primaryContentHash: resolvedPrimaryContentHash,
            royaltyShares: storyRoyaltySharesForRegistration,
          })
        : null
      if (royaltyRegistration) {
        applyRoyaltyRegistrationFields(storyRegistration, royaltyRegistration)
        storyStatus = "published"
        publicationStatus = "story_published"
        if ((input.post.rights_basis ?? "none") === "derivative" && !royaltyRegistration.storyLicenseTermsId) {
          storyRegistration.effectiveLicensePreset = null
          storyRegistration.effectiveCommercialRevSharePct = null
        }
        if (storyRoyaltySharesForRegistration && storyRoyaltySharesForRegistration.length > 0) {
          storyRoyaltyAllocationDistributionTxHash = royaltyRegistration.royaltyDistributionTxHash
          royaltyAllocationStatus = "verification_pending"
        }
      } else if (shouldRegisterRoyalty && storyRegistration.storyRoyaltyRegistrationStatus === "pending") {
        const registrationError = isStoryRoyaltyRegistrationConfigured(input.env)
          ? "story_royalty_registration_unavailable"
          : "story_royalty_config_missing"
        storyRegistration.storyRoyaltyRegistrationStatus = "failed"
        storyError = storyError
          ? `${storyError};royalty_registration_failed:${registrationError}`
          : `royalty_registration_failed:${registrationError}`
      }
    } catch (error) {
      const registrationError = error instanceof Error ? error.message : String(error)
      storyRegistration.storyRoyaltyRegistrationStatus = "failed"
      storyError = storyError ? `${storyError};royalty_registration_failed:${registrationError}` : `royalty_registration_failed:${registrationError}`
    }
  }

  if (shouldRegisterRoyalty && storyRegistration.storyRoyaltyRegistrationStatus === "failed" && input.requireStoryRoyaltyRegistration) {
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
      storyRegistration.effectiveLicensePreset,
      storyRegistration.effectiveCommercialRevSharePct,
      input.storageRef,
      resolvedPrimaryContentHash,
      publicationStatus,
      storyStatus,
      storyError,
      storyRegistration.storyIpId,
      storyRegistration.storyIpNftContract,
      storyRegistration.storyIpNftTokenId,
      storyRegistration.ipRoyaltyVault,
      storyRegistration.storyPublishModel,
      storyRegistration.storyLicenseTermsId,
      storyRegistration.storyLicenseTemplate,
      storyRegistration.storyRoyaltyPolicy,
      storyRegistration.storyRoyaltyPolicyId,
      storyRegistration.storyDerivativeParentIpIdsJson,
      storyRegistration.storyDerivativeRegisteredAt,
      storyRegistration.storyRevenueToken,
      storyRegistration.storyRoyaltyRegistrationStatus,
      lockedDeliveryStatus,
      lockedDeliveryRef,
      lockedDeliveryError,
      createdAt,
      storyRegistration.storyPublishTxRef,
      storyRegistration.storyAssetVersionId,
      storyRegistration.storyCdrVaultUuid,
      storyRegistration.storyNamespace,
      storyRegistration.storyEntitlementTokenId,
      storyRegistration.storyReadCondition,
      storyRegistration.storyWriteCondition,
      lockedDeliveryStorageRef,
      lockedDeliveryMetadataJson,
      royaltyAllocationStatus,
      ROYALTY_ALLOCATION_VERSION,
      royaltyAllocationFingerprint,
      allocationStatements.length === 0 ? 1 : 0,
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
      ipRoyaltyVault: storyRegistration.ipRoyaltyVault,
      distributionTxHash: storyRoyaltyAllocationDistributionTxHash,
      registeredAt: nowIso(),
    })
  }
  const projectionCandidate = {
    assetKind: input.assetKind,
    publicationStatus,
    storyStatus,
    storyRoyaltyRegistrationStatus: storyRegistration.storyRoyaltyRegistrationStatus,
    storyIpId: storyRegistration.storyIpId,
    storyLicenseTermsId: storyRegistration.storyLicenseTermsId,
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
          licensePreset: storyRegistration.effectiveLicensePreset,
          commercialRevSharePct: storyRegistration.effectiveCommercialRevSharePct,
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
  onProgress?: LockedDeliveryProgressReporter | null
}): Promise<Asset> {
  const asset = await getAssetRow(input.client, input.communityId, input.assetId)
  if (!asset) {
    throw notFoundError("Asset not found")
  }
  if (asset.access_mode !== "locked") {
    return serializeAsset(asset)
  }
  if (asset.locked_delivery_status === "ready") {
    if (
      asset.royalty_allocation_projection_synced === 0
      && asset.royalty_allocation_status !== "none"
    ) {
      await syncStoryRoyaltyAllocationProjectionSafely({
        env: input.env,
        client: input.client,
        communityId: input.communityId,
        postId: asset.source_post_id,
        assetId: asset.asset_id,
        sourceUpdatedAt: asset.updated_at,
        required: true,
      })
    }
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
  try {
    await assertAssetNotBlockedByRightsHold({
      client: input.client,
      communityId: input.communityId,
      asset,
    })
  } catch (error) {
    if (!(error instanceof Error) || error.message !== blockedRightsHoldMessage()) {
      throw error
    }
    await input.client.execute({
      sql: `
        UPDATE assets
        SET story_status = 'failed',
            story_error = ?3,
            locked_delivery_status = 'failed',
            locked_delivery_error = ?3,
            updated_at = ?4
        WHERE community_id = ?1
          AND asset_id = ?2
      `,
      args: [input.communityId, asset.asset_id, "rights_hold_blocked", nowIso()],
    })
    throw error
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
  const storyRegistration = storyRegistrationFieldStateFromAsset(asset, { storyIpId: null })
  let lockedDeliveryRef: string | null = asset.locked_delivery_ref
  let lockedDeliveryStorageRef: string | null = asset.locked_delivery_storage_ref
  let lockedDeliveryMetadataJson: string | null = asset.locked_delivery_secret_json

  try {
    await recordLockedDeliveryProgress(input.onProgress, "locked_delivery_started", {
      asset_id: asset.asset_id,
    })
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
      onProgress: input.onProgress ?? null,
      preparedDelivery: asset.story_asset_version_id
        && asset.story_cdr_vault_uuid
        && asset.story_namespace
        && asset.story_entitlement_token_id
        && asset.story_read_condition
        && asset.story_write_condition
        && asset.locked_delivery_ref
        && asset.locked_delivery_storage_ref
        && asset.locked_delivery_secret_json
        ? {
          storyAssetVersionId: asset.story_asset_version_id,
          storyCdrVaultUuid: asset.story_cdr_vault_uuid,
          storyNamespace: asset.story_namespace,
          storyEntitlementTokenId: asset.story_entitlement_token_id,
          storyReadCondition: asset.story_read_condition,
          storyWriteCondition: asset.story_write_condition,
          lockedDeliveryRef: asset.locked_delivery_ref,
          lockedDeliveryStorageRef: asset.locked_delivery_storage_ref,
          lockedDeliveryMetadataJson: asset.locked_delivery_secret_json,
        }
        : null,
      onPreparedDelivery: async (prepared) => {
        await input.client.execute({
          sql: `
            UPDATE assets
            SET story_asset_version_id = ?3,
                story_cdr_vault_uuid = ?4,
                story_namespace = ?5,
                story_entitlement_token_id = ?6,
                story_read_condition = ?7,
                story_write_condition = ?8,
                locked_delivery_ref = ?9,
                locked_delivery_storage_ref = ?10,
                locked_delivery_secret_json = ?11,
                updated_at = ?12
            WHERE community_id = ?1
              AND asset_id = ?2
          `,
          args: [
            input.communityId,
            asset.asset_id,
            prepared.storyAssetVersionId,
            prepared.storyCdrVaultUuid,
            prepared.storyNamespace,
            prepared.storyEntitlementTokenId,
            prepared.storyReadCondition,
            prepared.storyWriteCondition,
            prepared.lockedDeliveryRef,
            prepared.lockedDeliveryStorageRef,
            prepared.lockedDeliveryMetadataJson,
            nowIso(),
          ],
        })
        const checkpoint = await input.client.execute({
          sql: `
            SELECT story_asset_version_id,
                   story_cdr_vault_uuid,
                   story_namespace,
                   story_entitlement_token_id,
                   story_read_condition,
                   story_write_condition,
                   locked_delivery_ref,
                   locked_delivery_storage_ref,
                   locked_delivery_secret_json
            FROM assets
            WHERE community_id = ?1
              AND asset_id = ?2
            LIMIT 1
          `,
          args: [
            input.communityId,
            asset.asset_id,
          ],
        })
        const row = checkpoint.rows[0]
        const checkpointMatches = row
          && String(row.story_asset_version_id ?? "") === prepared.storyAssetVersionId
          && Number(row.story_cdr_vault_uuid ?? 0) === prepared.storyCdrVaultUuid
          && String(row.story_namespace ?? "") === prepared.storyNamespace
          && String(row.story_entitlement_token_id ?? "") === prepared.storyEntitlementTokenId
          && String(row.story_read_condition ?? "") === prepared.storyReadCondition
          && String(row.story_write_condition ?? "") === prepared.storyWriteCondition
          && String(row.locked_delivery_ref ?? "") === prepared.lockedDeliveryRef
          && String(row.locked_delivery_storage_ref ?? "") === prepared.lockedDeliveryStorageRef
          && String(row.locked_delivery_secret_json ?? "") === prepared.lockedDeliveryMetadataJson
        if (!checkpointMatches) {
          throw new Error("locked_delivery_checkpoint_not_persisted")
        }
        await recordLockedDeliveryProgress(input.onProgress, "locked_delivery_checkpoint_persisted", {
          asset_version_id: prepared.storyAssetVersionId,
          cdr_vault_uuid: prepared.storyCdrVaultUuid,
        })
      },
    })
    storyStatus = lockedDelivery.storyStatus
    if (lockedDelivery.storyStatus === "published") {
      publicationStatus = "story_published"
    }
    storyRegistration.storyPublishTxRef = lockedDelivery.storyPublishTxRef
    storyRegistration.storyIpId = lockedDelivery.storyIpId
    storyRegistration.storyRoyaltyPolicyId = lockedDelivery.storyRoyaltyPolicyId
    storyRegistration.storyDerivativeParentIpIdsJson = lockedDelivery.storyDerivativeParentIpIdsJson
    if (lockedDelivery.storyRoyaltyRegistrationStatus) {
      storyRegistration.storyRoyaltyRegistrationStatus = lockedDelivery.storyRoyaltyRegistrationStatus
    }
    storyRegistration.storyAssetVersionId = lockedDelivery.storyAssetVersionId
    storyRegistration.storyCdrVaultUuid = lockedDelivery.storyCdrVaultUuid
    storyRegistration.storyNamespace = lockedDelivery.storyNamespace
    storyRegistration.storyEntitlementTokenId = lockedDelivery.storyEntitlementTokenId
    storyRegistration.storyReadCondition = lockedDelivery.storyReadCondition
    storyRegistration.storyWriteCondition = lockedDelivery.storyWriteCondition
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
    const shouldRunRoyaltyRegistration = shouldRegisterRoyalty && storyRegistration.storyRoyaltyRegistrationStatus !== "registered"
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
      applyReusableOriginalRegistrationFields(storyRegistration, reusableOriginalRegistration)
      storyStatus = "published"
      publicationStatus = "story_published"
      storyError = null
    }

    const royaltyRegistration = shouldRunRoyaltyRegistration && !reusableOriginalRegistration
      ? await withLockedDeliveryProgressHeartbeat({
          env: input.env,
          progress: input.onProgress,
          checkpoint: "royalty_registration_started",
          heartbeatCheckpoint: "royalty_registration_waiting",
          details: {
            asset_id: asset.asset_id,
            rights_basis: asset.rights_basis,
          },
          operation: () => maybeRegisterStoryRoyaltyForAsset({
            env: input.env,
            client: input.client,
            communityId: input.communityId,
            assetId: asset.asset_id,
            creatorWalletAddress,
            title: post.title ?? null,
            rightsBasis: asset.rights_basis,
            licensePreset: storyRegistration.effectiveLicensePreset,
            commercialRevSharePct: storyRegistration.effectiveCommercialRevSharePct,
            upstreamAssetRefs: post.upstream_asset_refs ?? null,
            assetKind: asset.asset_kind,
            bundle,
            primaryContentHash: resolvedPrimaryContentHash,
          }),
        })
      : null
    if (royaltyRegistration) {
      await recordLockedDeliveryProgress(input.onProgress, "royalty_registration_completed", {
        story_ip_id: royaltyRegistration.storyIpId,
        ip_royalty_vault: royaltyRegistration.ipRoyaltyVault,
      })
      applyRoyaltyRegistrationFields(storyRegistration, royaltyRegistration)
      storyStatus = "published"
      publicationStatus = "story_published"
      if (asset.rights_basis === "derivative" && !royaltyRegistration.storyLicenseTermsId) {
        storyRegistration.effectiveLicensePreset = null
        storyRegistration.effectiveCommercialRevSharePct = null
      }
      await markStoryRoyaltyAllocationRegistrationPendingVerification({
        client: input.client,
        communityId: input.communityId,
        assetId: asset.asset_id,
        ipRoyaltyVault: storyRegistration.ipRoyaltyVault,
        distributionTxHash: royaltyRegistration.royaltyDistributionTxHash,
        registeredAt: nowIso(),
      })
    } else if (shouldRegisterRoyalty && storyRegistration.storyRoyaltyRegistrationStatus === "pending") {
      const registrationError = isStoryRoyaltyRegistrationConfigured(input.env)
        ? "story_royalty_registration_unavailable"
        : "story_royalty_config_missing"
      storyRegistration.storyRoyaltyRegistrationStatus = "failed"
      storyError = `royalty_registration_failed:${registrationError}`
    }
  } catch (error) {
    const registrationError = error instanceof Error ? error.message : String(error)
    storyRegistration.storyRoyaltyRegistrationStatus = "failed"
    storyError = `royalty_registration_failed:${registrationError}`
  }

  if (shouldRegisterRoyalty && storyRegistration.storyRoyaltyRegistrationStatus === "failed") {
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
      storyRegistration.storyIpId,
      storyRegistration.storyIpNftContract,
      storyRegistration.storyIpNftTokenId,
      storyRegistration.ipRoyaltyVault,
      storyRegistration.storyPublishModel,
      storyRegistration.storyLicenseTermsId,
      storyRegistration.storyLicenseTemplate,
      storyRegistration.storyRoyaltyPolicy,
      storyRegistration.storyRoyaltyPolicyId,
      storyRegistration.storyDerivativeParentIpIdsJson,
      storyRegistration.storyDerivativeRegisteredAt,
      storyRegistration.storyRevenueToken,
      storyRegistration.storyRoyaltyRegistrationStatus,
      storyRegistration.storyPublishTxRef,
      storyRegistration.storyAssetVersionId,
      storyRegistration.storyCdrVaultUuid,
      storyRegistration.storyNamespace,
      storyRegistration.storyEntitlementTokenId,
      storyRegistration.storyReadCondition,
      storyRegistration.storyWriteCondition,
      lockedDeliveryRef,
      lockedDeliveryStorageRef,
      lockedDeliveryMetadataJson,
      storyRegistration.effectiveLicensePreset,
      storyRegistration.effectiveCommercialRevSharePct,
      updatedAt,
    ],
  })

  const projectionCandidate = {
    assetKind: asset.asset_kind,
    publicationStatus,
    storyStatus,
    storyRoyaltyRegistrationStatus: storyRegistration.storyRoyaltyRegistrationStatus,
    storyIpId: storyRegistration.storyIpId,
    storyLicenseTermsId: storyRegistration.storyLicenseTermsId,
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
          licensePreset: storyRegistration.effectiveLicensePreset,
          commercialRevSharePct: storyRegistration.effectiveCommercialRevSharePct,
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
    await withLockedDeliveryProgressHeartbeat({
      env: input.env,
      progress: input.onProgress,
      checkpoint: "projection_sync_started",
      details: {
        asset_id: asset.asset_id,
      },
      operation: async () => {
        await syncStoryRoyaltyAllocationProjectionSafely({
          env: input.env,
          client: input.client,
          communityId: input.communityId,
          postId: post.post_id,
          assetId: asset.asset_id,
          sourceUpdatedAt: post.updated_at ?? updatedAt,
          required: true,
        })
      },
    })
    await recordLockedDeliveryProgress(input.onProgress, "projection_sync_completed", {
      asset_id: asset.asset_id,
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

export * from "./policy-service"
export * from "./listing-service"
export * from "./quote-service"
export * from "./settlement-service"
