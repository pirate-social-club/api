import { createCipheriv, createHash, randomBytes } from "node:crypto"
import { openCommunityDb } from "../communities/community-db-factory"
import type { CommunityRepository } from "../communities/control-plane-community-repository"
import { nowIso } from "../helpers"
import type { Asset, Env } from "../../types"
import {
  claimAssetForLockedDelivery,
  completeAssetLockedDelivery,
  failAssetLockedDelivery,
  type LockedDeliveryPayload,
  listAssetsPendingLockedDelivery,
} from "./community-asset-store"
import { getStoryAeneidDeliveryDefaults } from "./story-delivery-config"
import { persistSongArtifactUpload } from "./local-song-artifact-upload-storage"
import { readStoredSongArtifactBytes } from "./song-artifact-storage"
import { hasStoryCdrApiConfigured, writeLockedDeliveryToStoryCdr } from "./story-cdr-runtime"
import { hasStoryCdrSdkWriterConfigured, uploadSongAssetToCdrViaSdk } from "./story-cdr-sdk-runtime"

function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.trim().slice(0, 500) || "unknown_error"
}

function parsePositiveInt(value: string | null | undefined, fallback: number): number {
  const parsed = Number(String(value ?? "").trim())
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.max(1, Math.trunc(parsed))
}

function isoBeforeSeconds(seconds: number): string | null {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null
  }
  return new Date(Date.now() - (seconds * 1000)).toISOString()
}

function hashHex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function deriveVaultUuid(assetId: string): number {
  const value = Number.parseInt(hashHex(`vault:${assetId}`).slice(0, 8), 16)
  return (value % 2147483646) + 1
}

function deriveEntitlementTokenId(asset: Asset): string {
  const seed = asset.story_asset_version_id || `asset:${asset.asset_id}`
  return BigInt(`0x${hashHex(`token:${seed}`).slice(0, 30)}`).toString(10)
}

function requireAddress(value: string | null | undefined, label: string): string {
  const normalized = String(value || "").trim()
  if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) {
    throw new Error(`${label}_invalid`)
  }
  return normalized
}

function requireNonEmptyString(value: string | null | undefined, label: string): string {
  const normalized = String(value || "").trim()
  if (!normalized) {
    throw new Error(`${label}_missing`)
  }
  return normalized
}

async function prepareLockedDelivery(input: {
  env: Env
  asset: Asset
}): Promise<{
  lockedDeliveryRef: string
  lockedDeliveryPayload: LockedDeliveryPayload | null
  storyCdrVaultUuid: number
  storyCdrEncryptedCid: string | null
  storyCdrAllocateTxRef: string | null
  storyCdrWriteTxRef: string | null
  storyEntitlementTokenId: string
  storyReadCondition: string
  storyWriteCondition: string
}> {
  if (String(input.env.LOCKED_DELIVERY_FORCE_FAIL || "").trim().toLowerCase() === "true") {
    throw new Error("locked_delivery_forced_failure")
  }

  const defaults = getStoryAeneidDeliveryDefaults()
  const entitlementToken = requireAddress(
    input.env.STORY_ENTITLEMENT_TOKEN_ADDRESS || defaults.purchaseEntitlementToken,
    "story_entitlement_token_address",
  )
  const readCondition = requireAddress(
    input.env.STORY_TOKEN_GATE_CONDITION_ADDRESS || defaults.tokenGateCondition,
    "story_token_gate_condition_address",
  )
  const writeCondition = requireAddress(
    input.env.STORY_SIGNED_ACCESS_CONDITION_ADDRESS || defaults.signedAccessConditionV1,
    "story_signed_access_condition_address",
  )
  const storyEntitlementTokenId = input.asset.story_entitlement_token_id || deriveEntitlementTokenId(input.asset)
  if (hasStoryCdrSdkWriterConfigured(input.env)) {
    return await uploadSongAssetToCdrViaSdk({
      env: input.env,
      asset: input.asset,
      storyEntitlementTokenId,
    })
  }
  const storyCdrVaultUuid = input.asset.story_cdr_vault_uuid ?? deriveVaultUuid(input.asset.asset_id)
  // Locked delivery protects the full audio payload only. Preview, cover, and canvas remain public sidecar media.
  const sourceStorageRef = requireNonEmptyString(input.asset.primary_content_ref, "primary_content_ref")
  const sourceBytes = await readStoredSongArtifactBytes(input.env, sourceStorageRef)
  if (sourceBytes.byteLength === 0) {
    throw new Error("locked_delivery_source_empty")
  }
  const contentKey = randomBytes(32)
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", contentKey, iv)
  const encryptedBytes = Buffer.concat([
    cipher.update(Buffer.from(sourceBytes)),
    cipher.final(),
  ])
  const authTag = cipher.getAuthTag()
  const persisted = await persistSongArtifactUpload({
    env: input.env,
    uploadId: `ldp_${input.asset.asset_id}`,
    bytes: new Uint8Array(encryptedBytes),
    artifactKind: "locked_payload",
    mimeType: "application/octet-stream",
  })
  const lockedDeliveryPayload: LockedDeliveryPayload = {
    kind: "song.locked_delivery.v1",
    version: 1,
    encrypted_blob_ref: persisted.storageRef,
    encrypted_blob_hash: persisted.contentHash,
    encrypted_blob_size_bytes: persisted.sizeBytes,
    algorithm: "aes-256-gcm",
    iv_base64: iv.toString("base64"),
    auth_tag_base64: authTag.toString("base64"),
    content_key_base64: contentKey.toString("base64"),
    source_mime_type: "application/octet-stream",
    source_size_bytes: sourceBytes.byteLength,
    source_content_hash: input.asset.primary_content_hash,
    source_storage_ref: sourceStorageRef,
  }
  const lockedDeliveryRef = hasStoryCdrApiConfigured(input.env)
    ? await writeLockedDeliveryToStoryCdr({
      env: input.env,
      asset: input.asset,
      storyCdrVaultUuid,
      storyEntitlementTokenId,
      storyReadCondition: readCondition,
      storyWriteCondition: writeCondition,
      lockedDeliveryPayload,
    })
    : `pirate-cdr://assets/${input.asset.asset_id}/vault/${storyCdrVaultUuid}?entitlement=${entitlementToken}&blob_ref=${encodeURIComponent(persisted.storageRef)}`
  return {
    lockedDeliveryRef,
    lockedDeliveryPayload,
    storyCdrVaultUuid,
    storyCdrEncryptedCid: null,
    storyCdrAllocateTxRef: null,
    storyCdrWriteTxRef: null,
    storyEntitlementTokenId,
    storyReadCondition: readCondition,
    storyWriteCondition: writeCondition,
  }
}

export function parseSongLockedDeliveryDrainLimit(value: string | null | undefined, env: Env): number {
  return parsePositiveInt(value ?? env.SONG_LOCKED_DELIVERY_DRAIN_LIMIT, 10)
}

function parseSongLockedDeliveryStaleAfterSeconds(env: Env): number {
  return parsePositiveInt(env.SONG_LOCKED_DELIVERY_STALE_AFTER_SECONDS, 900)
}

export async function drainPendingSongAssetLockedDeliveries(input: {
  env: Env
  limit: number
  communityRepository: CommunityRepository
}): Promise<{
  scanned_count: number
  claimed_count: number
  processed_count: number
  ready_count: number
  failed_count: number
}> {
  const communities = await input.communityRepository.listActiveCommunities()
  const staleBefore = isoBeforeSeconds(parseSongLockedDeliveryStaleAfterSeconds(input.env))
  const counts = {
    scanned_count: 0,
    claimed_count: 0,
    processed_count: 0,
    ready_count: 0,
    failed_count: 0,
  }

  let remaining = Math.max(1, Math.trunc(input.limit))
  for (const community of communities) {
    if (remaining <= 0) {
      break
    }
    const db = await openCommunityDb(input.communityRepository, community.community_id)
    try {
      const candidates = await listAssetsPendingLockedDelivery({
        client: db.client,
        limit: remaining,
        staleBefore,
      })
      counts.scanned_count += candidates.length

      for (const candidate of candidates) {
        if (remaining <= 0) {
          break
        }
        const claimed = await claimAssetForLockedDelivery({
          client: db.client,
          assetId: candidate.asset_id,
          staleBefore,
          updatedAt: nowIso(),
        })
        if (!claimed) {
          continue
        }
        counts.claimed_count += 1

        try {
          const prepared = await prepareLockedDelivery({
            env: input.env,
            asset: claimed,
          })
          await completeAssetLockedDelivery({
            client: db.client,
            assetId: claimed.asset_id,
            lockedDeliveryRef: prepared.lockedDeliveryRef,
            lockedDeliveryPayload: prepared.lockedDeliveryPayload,
            storyCdrVaultUuid: prepared.storyCdrVaultUuid,
            storyCdrEncryptedCid: prepared.storyCdrEncryptedCid,
            storyCdrAllocateTxRef: prepared.storyCdrAllocateTxRef,
            storyCdrWriteTxRef: prepared.storyCdrWriteTxRef,
            storyEntitlementTokenId: prepared.storyEntitlementTokenId,
            storyReadCondition: prepared.storyReadCondition,
            storyWriteCondition: prepared.storyWriteCondition,
            updatedAt: nowIso(),
          })
          counts.ready_count += 1
        } catch (error) {
          await failAssetLockedDelivery({
            client: db.client,
            assetId: claimed.asset_id,
            error: summarizeError(error),
            updatedAt: nowIso(),
          })
          counts.failed_count += 1
        }

        counts.processed_count += 1
        remaining -= 1
      }
    } finally {
      db.close()
    }
  }

  return counts
}
