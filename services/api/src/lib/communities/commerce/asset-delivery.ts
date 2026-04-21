import { AbiCoder } from "ethers"
import { badRequestError, notFoundError } from "../../errors"
import { isLocalEnvironment } from "../../helpers"
import { getControlPlaneClient } from "../../runtime-deps"
import {
  fetchSongArtifactBytes,
  sha256Hex,
  uploadFilebaseObject,
} from "../../song-artifacts/song-artifact-storage"
import { findUploadedSongArtifactByStorageRef } from "../../song-artifacts/song-artifact-repository"
import {
  generateStorySignedAccessProof,
  type StoryAccessScope,
} from "../../story/story-access-proof-service"
import {
  deriveEntitlementTokenId,
  deriveStorageRefHash,
  deriveStoryAssetVersionId,
  deriveStoryNamespace,
  encodeTokenGateConditionData,
  encodeWriteConditionOperatorData,
  hashBytes32FromParts,
} from "../../story/story-identifiers"
import {
  estimateStoryCdrLockedPublishMinimumBalanceWei,
  resolveStoryCdrContracts,
  uploadCdrEncryptedDataKey,
} from "../../story/story-cdr"
import { resolveStoryCdrWriterDirectSigner } from "../../story/story-direct-signer"
import { publishLockedAssetVersionToStory } from "../../story/story-publish-service"
import { assertStoryRuntimeSignerFunding } from "../../story/story-runtime-funding"
import {
  resolveStoryChainId,
  resolveStoryRpcUrl,
  STORY_DELIVERY_CONTRACTS,
} from "../../story/story-runtime-config"
import {
  type AssetRow,
  buildAssetContentPath,
  parseJsonValue,
} from "./shared"
import type {
  Asset,
  AssetAccessResponse,
  Env,
  Post,
  SongArtifactBundle,
} from "../../../types"

type LockedDeliverySecret = {
  algorithm: "AES-GCM"
  iv_b64: string
  mime_type: string
}

const abiCoder = AbiCoder.defaultAbiCoder()

function toOwnedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes)
}

function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

async function encryptLockedPayload(bytes: Uint8Array): Promise<{
  ciphertext: Uint8Array
  dataKey: Uint8Array
  metadata: LockedDeliverySecret
}> {
  const keyBytes = crypto.getRandomValues(new Uint8Array(32))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["encrypt"])
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, toOwnedBytes(bytes)),
  )
  return {
    ciphertext,
    dataKey: keyBytes,
    metadata: {
      algorithm: "AES-GCM",
      iv_b64: toBase64(iv),
      mime_type: "audio/mpeg",
    },
  }
}

function encodeStoryAccessAuxData(input: {
  vaultUuid: number
  caller: string
  accessRef: `0x${string}`
  scope: `0x${string}`
  expiry: number
  namespace: `0x${string}`
  signature: `0x${string}`
}): `0x${string}` {
  return abiCoder.encode(
    [
      "tuple(uint32 vaultUuid,address caller,bytes32 accessRef,bytes32 scope,uint64 expiry,bytes32 namespace)",
      "bytes",
    ],
    [
      {
        vaultUuid: input.vaultUuid,
        caller: input.caller,
        accessRef: input.accessRef,
        scope: input.scope,
        expiry: input.expiry,
        namespace: input.namespace,
      },
      input.signature,
    ],
  ) as `0x${string}`
}

function buildStoryAccessRef(input: {
  communityId: string
  assetId: string
  userId: string
  decisionReason: AssetAccessResponse["decision_reason"]
}): `0x${string}` {
  return hashBytes32FromParts(
    "pirate-v2",
    "story-access",
    input.communityId,
    input.assetId,
    input.userId,
    input.decisionReason,
  )
}

export async function buildStoryCdrAccessPackage(input: {
  env: Env
  asset: AssetRow
  callerWalletAddress: string
  userId: string
  decisionReason: "creator" | "moderator" | "purchase_entitlement"
}): Promise<NonNullable<AssetAccessResponse["story_cdr_access"]>> {
  if (!input.asset.story_cdr_vault_uuid || !input.asset.story_namespace || !input.asset.locked_delivery_secret_json) {
    throw notFoundError("Locked asset CDR metadata not found")
  }
  const chainId = resolveStoryChainId(input.env)
  const cdrContracts = resolveStoryCdrContracts(chainId)
  if (!cdrContracts) {
    throw badRequestError("Story CDR contracts are not configured for this chain")
  }
  const metadata = parseJsonValue<LockedDeliverySecret>(input.asset.locked_delivery_secret_json, {
    algorithm: "AES-GCM",
    iv_b64: "",
    mime_type: "application/octet-stream",
  })
  const accessScope: StoryAccessScope = input.decisionReason === "purchase_entitlement" ? "asset.share" : "asset.owner"
  const accessRef = buildStoryAccessRef({
    communityId: input.asset.community_id,
    assetId: input.asset.asset_id,
    userId: input.userId,
    decisionReason: input.decisionReason,
  })
  const readConditionAddress = input.asset.story_read_condition || STORY_DELIVERY_CONTRACTS.signedAccessConditionV1
  if (
    readConditionAddress === STORY_DELIVERY_CONTRACTS.tokenGateCondition
    && input.decisionReason === "purchase_entitlement"
  ) {
    return {
      chain_id: chainId,
      rpc_url: resolveStoryRpcUrl(input.env),
      cdr_contract_address: cdrContracts.cdrAddress,
      read_condition_address: readConditionAddress,
      ciphertext_ref: buildAssetContentPath(input.asset.community_id, input.asset.asset_id),
      cipher_algorithm: metadata.algorithm,
      cipher_iv_b64: metadata.iv_b64,
      mime_type: metadata.mime_type,
      vault_uuid: input.asset.story_cdr_vault_uuid,
      namespace: input.asset.story_namespace,
      access_scope: accessScope,
      access_ref: accessRef,
      access_aux_data_hex: "0x",
      access_proof: {
        mode: "token_gate",
        entitlement_token_id: input.asset.story_entitlement_token_id,
      },
    }
  }
  const accessProof = await generateStorySignedAccessProof({
    env: input.env,
    vaultUuid: input.asset.story_cdr_vault_uuid,
    callerAddress: input.callerWalletAddress,
    accessRef,
    scope: accessScope,
    expiry: Math.floor(Date.now() / 1000) + 300,
    namespace: input.asset.story_namespace as `0x${string}`,
    verifyingContract: readConditionAddress,
  })

  return {
    chain_id: chainId,
    rpc_url: resolveStoryRpcUrl(input.env),
    cdr_contract_address: cdrContracts.cdrAddress,
    read_condition_address: readConditionAddress,
    ciphertext_ref: buildAssetContentPath(input.asset.community_id, input.asset.asset_id),
    cipher_algorithm: metadata.algorithm,
    cipher_iv_b64: metadata.iv_b64,
    mime_type: metadata.mime_type,
    vault_uuid: input.asset.story_cdr_vault_uuid,
    namespace: input.asset.story_namespace,
    access_scope: accessScope,
    access_ref: accessRef,
    access_aux_data_hex: encodeStoryAccessAuxData({
      vaultUuid: accessProof.proof.vaultUuid,
      caller: accessProof.proof.caller,
      accessRef: accessProof.proof.accessRef,
      scope: accessProof.proof.scope,
      expiry: accessProof.proof.expiry,
      namespace: accessProof.proof.namespace,
      signature: accessProof.signature,
    }),
    access_proof: {
      digest: accessProof.digest,
      signature: accessProof.signature,
      signer_address: accessProof.signerAddress,
      caller: accessProof.proof.caller,
      access_ref: accessProof.proof.accessRef,
      scope: accessProof.proof.scope,
      expiry: accessProof.proof.expiry,
      namespace: accessProof.proof.namespace,
    },
  }
}

export async function prepareLockedSongAssetDelivery(input: {
  env: Env
  communityId: string
  assetId: string
  creatorWalletAddress: string
  bundle: SongArtifactBundle
  rightsBasis: Post["rights_basis"]
  upstreamAssetRefs: string[] | null
}): Promise<{
  storyStatus: Asset["story_status"]
  storyPublishTxRef: string
  storyIpId: string | null
  storyRoyaltyPolicyId: string | null
  storyDerivativeParentIpIdsJson: string | null
  storyRoyaltyRegistrationStatus: "none" | "pending" | "registered" | "failed" | null
  storyAssetVersionId: string
  storyCdrVaultUuid: number
  storyNamespace: string
  storyEntitlementTokenId: string
  storyReadCondition: string
  storyWriteCondition: string
  lockedDeliveryStatus: Asset["locked_delivery_status"]
  lockedDeliveryRef: string
  lockedDeliveryStorageRef: string
  lockedDeliveryMetadataJson: string
}> {
  const controlPlaneClient = getControlPlaneClient(input.env)
  const upload = await findUploadedSongArtifactByStorageRef({
    client: controlPlaneClient,
    communityId: input.communityId,
    storageRef: input.bundle.primary_audio.storage_ref,
    artifactKind: "primary_audio",
  })
  if (!upload?.storage_object_key) {
    throw badRequestError("Primary audio upload is missing locked-delivery storage metadata")
  }
  const upstream = await fetchSongArtifactBytes({
    env: input.env,
    objectKey: upload.storage_object_key,
  })
  const plaintext = new Uint8Array(await upstream.arrayBuffer())
  const { ciphertext, dataKey, metadata } = await encryptLockedPayload(plaintext)
  metadata.mime_type = input.bundle.primary_audio.mime_type

  const objectKey = `locked-assets/${input.communityId}/${input.assetId}/payload.bin`
  await uploadFilebaseObject({
    env: input.env,
    objectKey,
    mimeType: "application/octet-stream",
    bytes: ciphertext,
  })
  const primaryContentHash = (input.bundle.primary_audio.content_hash?.trim() || `0x${await sha256Hex(plaintext)}`) as `0x${string}`
  const assetVersionId = deriveStoryAssetVersionId({
    communityId: input.communityId,
    assetId: input.assetId,
    bundleId: input.bundle.song_artifact_bundle_id,
    primaryContentHash,
  })
  const namespace = deriveStoryNamespace(assetVersionId)
  const entitlementTokenId = deriveEntitlementTokenId(assetVersionId)
  const readConditionAddress = STORY_DELIVERY_CONTRACTS.tokenGateCondition
  const writeConditionAddress = STORY_DELIVERY_CONTRACTS.signedAccessConditionV1
  const storyPublishRightsBasis = input.rightsBasis === "original" || input.rightsBasis === "derivative"
    ? input.rightsBasis
    : "none"
  try {
    const cdrWriterMinimumBalanceWei = await estimateStoryCdrLockedPublishMinimumBalanceWei(input.env)
    await assertStoryRuntimeSignerFunding(input.env, [
      { name: "story-cdr-writer", minBalanceWei: cdrWriterMinimumBalanceWei },
      "story-operator",
    ])
    const writerConfig = resolveStoryCdrWriterDirectSigner(input.env)
    if (!writerConfig.ok) {
      throw badRequestError(writerConfig.error)
    }
    if (!writerConfig.value) {
      throw badRequestError("STORY_CDR_WRITER_PRIVATE_KEY missing/invalid")
    }
    const readConditionData = encodeTokenGateConditionData({
      entitlementTokenAddress: STORY_DELIVERY_CONTRACTS.purchaseEntitlementToken,
      tokenId: entitlementTokenId,
      minBalance: 1n,
    })
    const writeConditionData = encodeWriteConditionOperatorData(writerConfig.value.address)
    let cdrUpload: Awaited<ReturnType<typeof uploadCdrEncryptedDataKey>>
    try {
      cdrUpload = await uploadCdrEncryptedDataKey({
        env: input.env,
        dataKey,
        readConditionAddr: readConditionAddress,
        writeConditionAddr: writeConditionAddress,
        readConditionData,
        writeConditionData,
        accessAuxData: "0x",
      })
    } catch (error) {
      throw new Error(`cdr_write_failed:${error instanceof Error ? error.message : String(error)}`)
    }
    let storyPublish: Awaited<ReturnType<typeof publishLockedAssetVersionToStory>>
    try {
      storyPublish = await publishLockedAssetVersionToStory({
        env: input.env,
        publisherAddress: input.creatorWalletAddress,
        assetVersionId,
        cdrVaultUuid: cdrUpload.cdrVaultUuid,
        namespace,
        contentHash: primaryContentHash,
        storageRefHash: deriveStorageRefHash(objectKey),
        entitlementTokenId,
        readConditionAddress,
        writeConditionAddress,
        rightsBasis: storyPublishRightsBasis,
        upstreamAssetRefs: input.upstreamAssetRefs,
      })
    } catch (error) {
      throw new Error(`story_publish_failed:${error instanceof Error ? error.message : String(error)}`)
    }

    return {
      storyStatus: "published",
      storyPublishTxRef: storyPublish.publishTxHash,
      storyIpId: storyPublish.storyIpId ?? null,
      storyRoyaltyPolicyId: storyPublish.storyRoyaltyPolicyId ?? null,
      storyDerivativeParentIpIdsJson: storyPublish.storyDerivativeParentIpIds
        ? JSON.stringify(storyPublish.storyDerivativeParentIpIds)
        : null,
      storyRoyaltyRegistrationStatus: storyPublish.storyRoyaltyRegistrationStatus ?? null,
      storyAssetVersionId: assetVersionId,
      storyCdrVaultUuid: cdrUpload.cdrVaultUuid,
      storyNamespace: namespace,
      storyEntitlementTokenId: entitlementTokenId.toString(),
      storyReadCondition: readConditionAddress,
      storyWriteCondition: writeConditionAddress,
      lockedDeliveryStatus: "ready",
      lockedDeliveryRef: buildAssetContentPath(input.communityId, input.assetId),
      lockedDeliveryStorageRef: objectKey,
      lockedDeliveryMetadataJson: JSON.stringify(metadata),
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error)
    if (
      isLocalEnvironment(input.env.ENVIRONMENT)
      && (
        errorMessage.includes("STORY_CDR_WRITER_PRIVATE_KEY missing/invalid")
        || errorMessage.includes("STORY_OPERATOR_PRIVATE_KEY missing/invalid")
        || errorMessage.includes("STORY_CONTRACT_OWNER_PRIVATE_KEY missing/invalid")
      )
    ) {
      console.warn(`[story] local fallback for locked delivery: ${errorMessage}`)
      return {
        storyStatus: "published",
        storyPublishTxRef: hashBytes32FromParts("local-story-publish", assetVersionId),
        storyIpId: null,
        storyRoyaltyPolicyId: null,
        storyDerivativeParentIpIdsJson: null,
        storyRoyaltyRegistrationStatus: null,
        storyAssetVersionId: assetVersionId,
        storyCdrVaultUuid: Number.parseInt(assetVersionId.slice(-8), 16) || 1,
        storyNamespace: namespace,
        storyEntitlementTokenId: entitlementTokenId.toString(),
        storyReadCondition: readConditionAddress,
        storyWriteCondition: writeConditionAddress,
        lockedDeliveryStatus: "ready",
        lockedDeliveryRef: buildAssetContentPath(input.communityId, input.assetId),
        lockedDeliveryStorageRef: objectKey,
        lockedDeliveryMetadataJson: JSON.stringify(metadata),
      }
    }
    throw error instanceof Error ? error : new Error(errorMessage)
  }
}

export async function fetchPrimarySongAssetContent(input: {
  env: Env
  communityId: string
  storageRef: string
}): Promise<Response> {
  const controlPlaneClient = getControlPlaneClient(input.env)
  const upload = await findUploadedSongArtifactByStorageRef({
    client: controlPlaneClient,
    communityId: input.communityId,
    storageRef: input.storageRef,
    artifactKind: "primary_audio",
  })
  if (!upload?.storage_object_key) {
    throw notFoundError("Primary asset content not found")
  }
  return await fetchSongArtifactBytes({
    env: input.env,
    objectKey: upload.storage_object_key,
  })
}
