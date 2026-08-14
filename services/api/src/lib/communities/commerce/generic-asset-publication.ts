import type { Client } from "../../sql-client"
import { internalError, conflictError, notFoundError } from "../../errors"
import { genericDigitalGoodsEnabled, nowIso } from "../../helpers"
import { withTransaction } from "../../transactions"
import {
  claimOwnedReadyContentBlob,
  releaseOwnedContentBlobClaim,
  requireOwnedContentBlob,
} from "../../content-blobs/content-blob-repository"
import type { ContentBlobRow, OwnedContentBlob } from "../../content-blobs/content-blob-types"
import {
  reconcileGenericAssetBytes,
  releaseGenericAssetBytes,
  reserveGenericAssetBytes,
  type GenericAssetQuotaReservation,
} from "./generic-asset-quota-reservation"
import { getAssetRow } from "./queries"
import { getActivePrimaryAssetPayload, getAssetEnforcement } from "./generic-asset-repository"
import { isGenericAssetKind } from "./asset-kind-policy"
import type { Asset, Env } from "../../../types"

type GenericAssetKind = Extract<Asset["asset_kind"], "download_file" | "learning_deck">

export type GenericAssetPublicationResult = {
  assetId: string
  contentBlob: ContentBlobRow
  quotaReservation: GenericAssetQuotaReservation
}

/**
 * Reserves physical-byte quota, claims a clean blob, and materializes the
 * generic asset's three shard rows as one write transaction. The transaction
 * is deliberately idempotent for retries of the same asset claim, but never
 * overwrites a later enforcement decision.
 */
export async function publishGenericAssetClaim(input: {
  env: Env
  shardClient: Client
  controlPlaneClient: Client
  communityId: string
  sourcePostId: string
  assetId: string
  creatorUserId: string
  contentBlobId: string
  assetKind: GenericAssetKind
  accessMode?: "locked"
  rightsBasis?: "none" | "original" | "derivative" | "attribution_only"
  licensePreset?: "non-commercial" | "commercial-use" | "commercial-remix" | null
  commercialRevSharePct?: number | null
  displayTitle?: string | null
  displayFilename: string
  mimeType: string
  contentHash?: string
  verifiedSizeBytes?: number
  reservationId: string
  reservationKey: string
  reservedBytes: number
  quotaPolicyVersion: string
  maxAccountedBytes?: number | null
  createdAt?: string
}): Promise<GenericAssetPublicationResult> {
  if (!genericDigitalGoodsEnabled(input.env)) {
    throw notFoundError("Generic digital goods are not enabled")
  }
  if (!isGenericAssetKind(input.assetKind)) {
    throw conflictError("Generic publication requires a generic asset kind")
  }
  const createdAt = input.createdAt ?? nowIso()
  const owned = await requireOwnedContentBlob({
    client: input.controlPlaneClient,
    communityId: input.communityId,
    uploaderUserId: input.creatorUserId,
    contentBlobId: input.contentBlobId,
  })
  const verifiedSizeBytes = input.verifiedSizeBytes ?? owned.blob.verified_size_bytes
  const contentHash = input.contentHash ?? owned.blob.verified_content_hash
  if (verifiedSizeBytes == null || !contentHash) {
    throw conflictError("Content blob is missing verified size or hash")
  }
  if (!Number.isSafeInteger(input.reservedBytes) || input.reservedBytes < verifiedSizeBytes) {
    throw conflictError("Generic asset quota reservation must cover the verified plaintext bytes")
  }

  const quotaReservation = await reserveGenericAssetBytes({
    client: input.controlPlaneClient,
    reservationId: input.reservationId,
    communityId: input.communityId,
    userId: input.creatorUserId,
    assetId: input.assetId,
    contentBlobId: input.contentBlobId,
    reservationKey: input.reservationKey,
    reservedBytes: input.reservedBytes,
    plaintextBytes: verifiedSizeBytes,
    policyVersion: input.quotaPolicyVersion,
    createdAt,
    maxAccountedBytes: input.maxAccountedBytes,
  })

  let claimed: OwnedContentBlob | null = null
  try {
    claimed = await claimOwnedReadyContentBlob({
      client: input.controlPlaneClient,
      communityId: input.communityId,
      uploaderUserId: input.creatorUserId,
      contentBlobId: input.contentBlobId,
      claimKind: "asset_payload",
      claimRef: input.assetId,
      claimedAt: createdAt,
    })
    await withTransaction(input.shardClient, "write", async (tx) => {
      const existing = await getAssetRow(tx, input.communityId, input.assetId)
      if (existing) {
        if (
          existing.source_post_id !== input.sourcePostId
          || existing.creator_user_id !== input.creatorUserId
          || existing.asset_kind !== input.assetKind
        ) {
          throw conflictError("Generic asset claim conflicts with an existing asset")
        }
      } else {
        await tx.execute({
          sql: `
            INSERT INTO assets (
              asset_id, community_id, source_post_id, creator_user_id, asset_kind,
              rights_basis, access_mode, license_preset, commercial_rev_share_pct,
              primary_content_ref, primary_content_hash,
              publication_status, story_status, locked_delivery_status,
              display_title, created_at, updated_at
            ) VALUES (
              ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
              NULL, ?10, 'story_requested', 'requested', 'requested', ?11, ?12, ?12
            )
          `,
          args: [
            input.assetId,
            input.communityId,
            input.sourcePostId,
            input.creatorUserId,
            input.assetKind,
            input.rightsBasis ?? "original",
            input.accessMode ?? "locked",
            input.licensePreset ?? null,
            input.commercialRevSharePct ?? null,
            contentHash,
            input.displayTitle ?? null,
            createdAt,
          ],
        })
      }

      const payload = await getActivePrimaryAssetPayload(tx, input.assetId)
      if (payload) {
        if (
          payload.content_blob_ref !== input.contentBlobId
          || payload.content_hash !== contentHash
          || payload.size_bytes !== verifiedSizeBytes
        ) {
          throw conflictError("Generic asset payload claim conflicts with an existing payload")
        }
      } else {
        await tx.execute({
          sql: `
            INSERT INTO asset_payloads (
              asset_payload_id, asset_id, role, payload_version, status,
              content_blob_ref, payload_format, delivery_behavior, display_filename,
              mime_type, size_bytes, content_hash, created_at, updated_at
            ) VALUES (
              ?1, ?2, 'primary', 1, 'active', ?3, ?4, ?5,
              ?6, ?7, ?8, ?9, ?10, ?10
            )
          `,
          args: [
            `ap_${input.assetId}`,
            input.assetId,
            input.contentBlobId,
            input.assetKind === "learning_deck" ? "learning_deck_package_v1" : "opaque_file_v1",
            input.assetKind === "learning_deck" ? "app_native" : "download",
            input.displayFilename,
            input.mimeType,
            verifiedSizeBytes,
            contentHash,
            createdAt,
          ],
        })
      }

      const enforcement = await getAssetEnforcement(tx, input.assetId)
      if (!enforcement) {
        await tx.execute({
          sql: `
            INSERT INTO asset_enforcement (
              asset_id, enforcement_state, reason_code, authority_kind,
              authority_ref, moderation_action_id, actor_role, evidence_ref,
              decided_at, updated_at
            ) VALUES (?1, 'active', NULL, 'asset_create', ?2, NULL, 'publisher', ?3, ?4, ?4)
          `,
          args: [input.assetId, input.assetId, input.contentBlobId, createdAt],
        })
      }
    })
  } catch (error) {
    await releaseOwnedContentBlobClaim({
      client: input.controlPlaneClient,
      communityId: input.communityId,
      uploaderUserId: input.creatorUserId,
      contentBlobId: input.contentBlobId,
      claimKind: "asset_payload",
      claimRef: input.assetId,
      releasedAt: nowIso(),
    })
    await releaseGenericAssetBytes({
      client: input.controlPlaneClient,
      reservationId: quotaReservation.reservation_id,
      releasedAt: nowIso(),
      failureCode: "asset_materialization_failed",
    })
    throw error
  }

  const asset = await getAssetRow(input.shardClient, input.communityId, input.assetId)
  if (!asset) throw internalError("Generic asset is missing after materialization")
  if (!claimed) throw internalError("Generic asset content blob claim is missing")
  return { assetId: asset.asset_id, contentBlob: claimed.blob, quotaReservation }
}

export async function finalizeGenericAssetQuota(input: {
  controlPlaneClient: Client
  reservationId: string
  plaintextBytes: number
  ciphertextBytes: number
  packageBytes: number
  maxAccountedBytes?: number | null
  reconciledAt?: string
}): Promise<GenericAssetQuotaReservation> {
  return await reconcileGenericAssetBytes({
    client: input.controlPlaneClient,
    reservationId: input.reservationId,
    actualBytes: input.plaintextBytes + input.ciphertextBytes + input.packageBytes,
    plaintextBytes: input.plaintextBytes,
    ciphertextBytes: input.ciphertextBytes,
    packageBytes: input.packageBytes,
    maxAccountedBytes: input.maxAccountedBytes,
    reconciledAt: input.reconciledAt ?? nowIso(),
  })
}
