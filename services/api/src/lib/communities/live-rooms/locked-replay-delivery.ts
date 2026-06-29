import { badRequestError } from "../../errors"
import { fetchSongArtifactBytes, uploadFilebaseObject } from "../../song-artifacts/song-artifact-storage"
import {
  estimateStoryCdrLockedPublishMinimumBalanceWei,
  uploadCdrEncryptedDataKey,
} from "../../story/story-cdr"
import { resolveStoryCdrWriterDirectSigner } from "../../story/story-direct-signer"
import {
  deriveEntitlementTokenId,
  deriveStoryAssetVersionId,
  deriveStoryNamespace,
  encodeCompositeReadConditionData,
  encodeWriteConditionOperatorData,
} from "../../story/story-identifiers"
import { assertStoryRuntimeSignerFunding } from "../../story/story-runtime-funding"
import {
  resolveStoryCompositeReadConditionAddress,
  resolveStoryRuntimeSignerTargetBalanceWei,
  STORY_DELIVERY_CONTRACTS,
} from "../../story/story-runtime-config"
import {
  encryptLockedPayload,
  type LockedDeliverySecret,
} from "../commerce/asset-delivery"
import type { Env } from "../../../types"
import type { LiveRoomRecordingRawArtifactRef } from "./recording-ingest"
import type { LiveRoomReplayAsset } from "./replay-assets"

export type LockedReplayDeliveryResult = {
  storyAssetVersionId: string
  storyCdrVaultUuid: number
  storyNamespace: string
  storyEntitlementTokenId: string
  storyReadCondition: string
  storyWriteCondition: string
  lockedDeliveryStorageRef: string
  lockedDeliveryMetadataJson: string
}

export async function prepareIncludedTicketReplayDelivery(input: {
  env: Env
  communityId: string
  liveRoomId: string
  replayAsset: LiveRoomReplayAsset
  rawArtifactRefJson: string
}): Promise<LockedReplayDeliveryResult> {
  const rawArtifact = parseRawArtifactRef(input.rawArtifactRefJson)
  const readConditionAddress = resolveStoryCompositeReadConditionAddress(input.env)
  if (!readConditionAddress) {
    throw badRequestError("STORY_COMPOSITE_READ_CONDITION_ADDRESS is required for locked replay publishing")
  }

  const source = await fetchSongArtifactBytes({
    env: input.env,
    objectKey: rawArtifact.object_key,
  })
  if (!source.ok) {
    const detail = await source.text().catch(() => "")
    throw badRequestError(
      `Replay recording fetch failed with status ${source.status}${detail ? `: ${detail}` : ""}`,
    )
  }
  const plaintext = new Uint8Array(await source.arrayBuffer())
  const { ciphertext, dataKey, metadata } = await encryptLockedPayload(plaintext)
  metadata.mime_type = rawArtifact.mime_type || "application/octet-stream"

  const lockedObjectKey = buildLockedReplayObjectKey({
    communityId: input.communityId,
    liveRoomId: input.liveRoomId,
    replayAssetId: input.replayAsset.replay_asset_id,
  })
  await uploadFilebaseObject({
    env: input.env,
    objectKey: lockedObjectKey,
    mimeType: "application/octet-stream",
    bytes: ciphertext,
  })

  const assetVersionId = deriveStoryAssetVersionId({
    communityId: input.communityId,
    assetId: input.replayAsset.replay_asset_id,
    bundleId: input.liveRoomId,
    primaryContentHash: rawArtifact.content_hash,
  })
  const namespace = deriveStoryNamespace(assetVersionId)
  const entitlementTokenId = deriveEntitlementTokenId(assetVersionId)
  const writerConfig = resolveStoryCdrWriterDirectSigner(input.env)
  if (!writerConfig.ok) {
    throw badRequestError(writerConfig.error)
  }
  if (!writerConfig.value) {
    throw badRequestError("STORY_CDR_WRITER_PRIVATE_KEY missing/invalid")
  }

  const cdrWriterMinimumBalanceWei = await estimateStoryCdrLockedPublishMinimumBalanceWei(input.env)
  const storyOperatorMinimumBalanceWei = resolveStoryRuntimeSignerTargetBalanceWei(input.env)
  await assertStoryRuntimeSignerFunding(input.env, [
    { name: "story-cdr-writer", minBalanceWei: cdrWriterMinimumBalanceWei },
    { name: "story-operator", minBalanceWei: storyOperatorMinimumBalanceWei },
  ])

  const writeConditionAddress = STORY_DELIVERY_CONTRACTS.signedAccessConditionV1
  const cdrUpload = await uploadCdrEncryptedDataKey({
    env: input.env,
    dataKey,
    readConditionAddr: readConditionAddress,
    writeConditionAddr: writeConditionAddress,
    readConditionData: encodeCompositeReadConditionData({
      entitlementTokenAddress: STORY_DELIVERY_CONTRACTS.purchaseEntitlementToken,
      tokenId: entitlementTokenId,
      minBalance: 1n,
      namespace,
    }),
    writeConditionData: encodeWriteConditionOperatorData(writerConfig.value.address),
    accessAuxData: "0x",
  })

  return {
    storyAssetVersionId: assetVersionId,
    storyCdrVaultUuid: cdrUpload.cdrVaultUuid,
    storyNamespace: namespace,
    storyEntitlementTokenId: entitlementTokenId.toString(),
    storyReadCondition: readConditionAddress,
    storyWriteCondition: writeConditionAddress,
    lockedDeliveryStorageRef: lockedObjectKey,
    lockedDeliveryMetadataJson: JSON.stringify(metadata satisfies LockedDeliverySecret),
  }
}

function parseRawArtifactRef(value: string): LiveRoomRecordingRawArtifactRef {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw badRequestError("Replay recording artifact metadata is invalid")
  }
  if (!parsed || typeof parsed !== "object") {
    throw badRequestError("Replay recording artifact metadata is invalid")
  }
  const record = parsed as Partial<LiveRoomRecordingRawArtifactRef>
  if (record.provider !== "filebase" || !record.object_key?.trim()) {
    throw badRequestError("Replay recording artifact is not available on Filebase")
  }
  if (!record.content_hash?.trim()) {
    throw badRequestError("Replay recording artifact is missing a content hash")
  }
  return {
    provider: "filebase",
    bucket: record.bucket ?? "",
    object_key: record.object_key,
    endpoint: record.endpoint ?? "",
    content_hash: record.content_hash,
    ipfs_cid: record.ipfs_cid ?? "",
    mime_type: record.mime_type ?? "application/octet-stream",
    size_bytes: Number(record.size_bytes ?? 0),
  }
}

function buildLockedReplayObjectKey(input: {
  communityId: string
  liveRoomId: string
  replayAssetId: string
}): string {
  return [
    "locked-replays",
    sanitizePathSegment(input.communityId),
    sanitizePathSegment(input.liveRoomId),
    sanitizePathSegment(input.replayAssetId),
    "payload.bin",
  ].join("/")
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 160) || "unknown"
}
