import type { UserRepository } from "../../auth/repositories"
import { sha256Hex } from "../../crypto"
import { badRequestError, notFoundError, providerUnavailable } from "../../errors"
import { nowIso } from "../../helpers"
import { logPipelineInfo } from "../../observability/pipeline-log"
import { getPostById } from "../../posts/community-post-query-store"
import { getControlPlaneClient } from "../../runtime-deps"
import { getSongArtifactBundle } from "../../song-artifacts/song-artifact-repository"
import { findUploadedSongArtifactByStorageRef } from "../../song-artifacts/song-artifact-upload-repository"
import type { Client } from "../../sql-client"
import {
  isStoryRoyaltyRegistrationConfigured,
  maybeRegisterStoryRoyaltyForAsset,
} from "../../story/story-royalty-registration-service"
import type { Asset, Env, SongArtifactUpload } from "../../../types"
import { prepareLockedAssetDelivery } from "./asset-delivery"
import { upsertStoryRegisteredAssetProjection } from "./derivative-source-projection"
import {
  recordLockedDeliveryProgress,
  withLockedDeliveryProgressHeartbeat,
  type LockedDeliveryProgressReporter,
} from "./locked-delivery-progress"
import { markStoryRoyaltyAllocationRegistrationPendingVerification } from "./royalty-allocations"
import { syncStoryRoyaltyAllocationProjectionSafely } from "./royalty-allocation-projection"
import type { AssetRow } from "./row-types"
import {
  assertAssetNotBlockedByRightsHold,
  blockedRightsHoldMessage,
} from "./rights-hold-gates"
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
import {
  applyReusableOriginalRegistrationFields,
  applyRoyaltyRegistrationFields,
  isCatalogProjectableStoryRegisteredAsset,
  isRoyaltyProjectableStoryRegisteredAsset,
  shouldAttemptStoryRoyaltyRegistration,
  storyRegistrationFieldStateFromAsset,
} from "./story-registration-state"

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
  if (!hasDeliveryMetadata) return false
  if (!input.requireStoryRoyaltyRegistration) return true
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
            accessMode: asset.access_mode,
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
          locked_delivery_status = 'ready',
          locked_delivery_ref = ?30,
          locked_delivery_error = NULL,
          locked_delivery_storage_ref = ?31,
          locked_delivery_secret_json = ?32,
          license_preset = ?33,
          commercial_rev_share_pct = ?34,
          updated_at = ?35
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
    ipRoyaltyVault: storyRegistration.ipRoyaltyVault,
    royaltyAllocationStatus: asset.royalty_allocation_status,
  }
  if (isCatalogProjectableStoryRegisteredAsset(projectionCandidate)) {
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
  if (isRoyaltyProjectableStoryRegisteredAsset(projectionCandidate)) {
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
