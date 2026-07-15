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
import { badRequestError, notFoundError, providerUnavailable } from "../../errors"
import { envFlag, isLocalEnvironment, nowIso } from "../../helpers"
import { logPipelineInfo } from "../../observability/pipeline-log"
import { sha256Hex } from "../../crypto"
import type { UserRepository } from "../../auth/repositories"
import {
  isStoryRoyaltyRegistrationConfigured,
  maybeRegisterStoryRoyaltyForAsset,
  type StoryLicensePreset,
} from "../../story/story-royalty-registration-service"
import type { AssetRow } from "./row-types"
import { prepareLockedAssetDelivery } from "./asset-delivery"
import {
  classifyStoryRegistrationFailure,
  isStoryRegistrationFailureRetryable,
  sanitizeStoryRegistrationFailure,
  storyRegistrationFailureMessage,
} from "./story-registration-failure"
import {
  findReusableRegisteredOriginalStoryAssetByContent,
  getAssetRow,
  resolvePrimaryWalletAddress,
  serializeAsset,
} from "./shared"
import { upsertStoryRegisteredAssetProjection } from "./derivative-source-projection"
import { syncStoryRoyaltyAllocationProjectionSafely } from "./royalty-allocation-projection"
import {
  applyReusableOriginalRegistrationFields,
  applyRoyaltyRegistrationFields,
  emptyStoryRegistrationFieldState,
  hasCompleteStoryRoyaltyRegistration,
  isCatalogProjectableStoryRegisteredAsset,
  isRoyaltyProjectableStoryRegisteredAsset,
  shouldAttemptStoryRoyaltyRegistration,
  storyRegistrationFieldStateFromAsset,
} from "./story-registration-state"
import type {
  Asset,
  Env,
  Post,
  SongArtifactBundle,
  SongArtifactUpload,
} from "../../../types"

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
        accessMode: asset.access_mode,
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
          story_ip_metadata_uri = ?9,
          story_ip_metadata_hash = ?10,
          story_nft_metadata_uri = ?11,
          story_nft_metadata_hash = ?12,
          ip_royalty_vault = ?13,
          story_publish_model = ?14,
          story_license_terms_id = ?15,
          story_license_template = ?16,
          story_royalty_policy = ?17,
          story_royalty_policy_id = ?18,
          story_derivative_parent_ip_ids_json = ?19,
          story_derivative_registered_at = ?20,
          story_revenue_token = ?21,
          story_royalty_registration_status = ?22,
          story_publish_tx_ref = ?23,
          story_asset_version_id = ?24,
          story_cdr_vault_uuid = ?25,
          story_namespace = ?26,
          story_entitlement_token_id = ?27,
          story_read_condition = ?28,
          story_write_condition = ?29,
          license_preset = ?30,
          commercial_rev_share_pct = ?31,
          updated_at = ?32
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
      storyRegistration.storyIpMetadataUri,
      storyRegistration.storyIpMetadataHash,
      storyRegistration.storyNftMetadataUri,
      storyRegistration.storyNftMetadataHash,
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
    story_ip_metadata_uri: storyRegistration.storyIpMetadataUri,
    story_ip_metadata_hash: storyRegistration.storyIpMetadataHash,
    story_nft_metadata_uri: storyRegistration.storyNftMetadataUri,
    story_nft_metadata_hash: storyRegistration.storyNftMetadataHash,
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

function shouldPrepareLockedDeliveryAsync(env: Pick<Env, "ENVIRONMENT" | "STORY_LOCKED_DELIVERY_ASYNC">): boolean {
  return envFlag(env.STORY_LOCKED_DELIVERY_ASYNC, !isLocalEnvironment(env.ENVIRONMENT))
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
            // Story metadata is permanent: an unknown access mode must never expose media.
            accessMode: input.post.access_mode ?? "locked",
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
        royalty_allocation_projection_synced,
        story_ip_metadata_uri, story_ip_metadata_hash, story_nft_metadata_uri, story_nft_metadata_hash
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
        ?43, ?44, ?45, ?46,
        ?47, ?48, ?49, ?50
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
      storyRegistration.storyIpMetadataUri,
      storyRegistration.storyIpMetadataHash,
      storyRegistration.storyNftMetadataUri,
      storyRegistration.storyNftMetadataHash,
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
    ipRoyaltyVault: storyRegistration.ipRoyaltyVault,
    royaltyAllocationStatus,
  }
  if (isCatalogProjectableStoryRegisteredAsset(projectionCandidate)) {
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
  if (isRoyaltyProjectableStoryRegisteredAsset(projectionCandidate)) {
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

export * from "./derivative-source-service"
export { prepareRequestedLockedAssetDelivery } from "./locked-delivery-service"
export {
  isCatalogProjectableStoryRegisteredAsset,
  isRoyaltyProjectableStoryRegisteredAsset,
} from "./story-registration-state"
export {
  fetchCommunityAssetContent,
  fetchPublicCommunityAssetContent,
  getCommunityAsset,
  resolveCommunityAssetAccess,
  resolvePublicCommunityAssetAccess,
} from "./asset-access-service"
export * from "./policy-service"
export * from "./listing-service"
export * from "./quote-service"
export * from "./settlement-service"
