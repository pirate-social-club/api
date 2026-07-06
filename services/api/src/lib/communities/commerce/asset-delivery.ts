import { AbiCoder } from "ethers"
import { badRequestError, notFoundError } from "../../errors"
import { isLocalEnvironment } from "../../helpers"
import { getControlPlaneClient } from "../../runtime-deps"
import {
  fetchSongArtifactBytes,
  uploadFilebaseObject,
} from "../../song-artifacts/song-artifact-storage"
import { sha256Hex } from "../../crypto"
import { findUploadedSongArtifactByStorageRef } from "../../song-artifacts/song-artifact-upload-repository"
import {
  generateStorySignedAccessProof,
  type StoryAccessScope,
} from "../../story/story-access-proof-service"
import {
  deriveEntitlementTokenId,
  deriveStorageRefHash,
  deriveStoryAssetVersionId,
  deriveStoryNamespace,
  encodeCompositeReadConditionData,
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
  resolveStoryCompositeReadConditionAddress,
  resolveStoryRpcUrl,
  resolveStoryRuntimeSignerTargetBalanceWei,
  STORY_DELIVERY_CONTRACTS,
} from "../../story/story-runtime-config"
import {
  buildAssetContentPath,
} from "./access"
import {
  type AssetRow,
  parseJsonValue,
} from "./row-types"
import type {
  Asset,
  AssetAccessResponse,
  Env,
  Post,
  SongArtifactBundle,
  SongArtifactUpload,
} from "../../../types"

export type LockedDeliverySecret = {
  algorithm: "AES-GCM"
  iv_b64: string
  mime_type: string
}

const abiCoder = AbiCoder.defaultAbiCoder()

export function sameStoryAddress(left: string | null | undefined, right: string | null | undefined): boolean {
  return String(left || "").toLowerCase() === String(right || "").toLowerCase()
}

type LockedAssetDeliveryResult = {
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
}

type PreparedLockedDeliveryCoordinates = {
  storyAssetVersionId: string
  storyCdrVaultUuid: number
  storyNamespace: string
  storyEntitlementTokenId: string
  storyReadCondition: string
  storyWriteCondition: string
  lockedDeliveryRef: string
  lockedDeliveryStorageRef: string
  lockedDeliveryMetadataJson: string
}

let testLockedAssetDeliveryPreparer: ((input: {
  env: Env
  communityId: string
  assetId: string
  creatorWalletAddress: string
  storageRef: string
  mimeType: string
  contentHash: string | null
  artifactKind: SongArtifactUpload["artifact_kind"]
  bundleId: string | null
  rightsBasis: Post["rights_basis"]
  upstreamAssetRefs: string[] | null
  preparedDelivery?: PreparedLockedDeliveryCoordinates | null
  onPreparedDelivery?: (prepared: PreparedLockedDeliveryCoordinates) => Promise<void>
}) => Promise<LockedAssetDeliveryResult>) | null = null

export function setLockedAssetDeliveryPreparerForTests(
  preparer: ((input: {
    env: Env
    communityId: string
    assetId: string
    creatorWalletAddress: string
    storageRef: string
    mimeType: string
    contentHash: string | null
    artifactKind: SongArtifactUpload["artifact_kind"]
    bundleId: string | null
    rightsBasis: Post["rights_basis"]
    upstreamAssetRefs: string[] | null
    preparedDelivery?: PreparedLockedDeliveryCoordinates | null
    onPreparedDelivery?: (prepared: PreparedLockedDeliveryCoordinates) => Promise<void>
  }) => Promise<LockedAssetDeliveryResult>) | null,
): void {
  testLockedAssetDeliveryPreparer = preparer
}

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

export async function encryptLockedPayload(bytes: Uint8Array): Promise<{
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
      mime_type: "application/octet-stream",
    },
  }
}

export function encodeStoryAccessAuxData(input: {
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

function formatCdrWriteFailure(error: unknown, env: Pick<Env, "ENVIRONMENT">): string {
  const message = error instanceof Error ? error.message : String(error)
  if (env.ENVIRONMENT === "production" || !(error instanceof Error) || !error.stack) {
    return message
  }
  const stack = error.stack.split("\n").slice(0, 6).map((line) => line.trim()).join(" | ")
  return `${message}; stack=${stack}`
}

function buildStoryAccessRef(input: {
  communityId: string
  subjectId: string
  userId: string
  decisionReason: string
}): `0x${string}` {
  return hashBytes32FromParts(
    "pirate",
    "story-access",
    input.communityId,
    input.subjectId,
    input.userId,
    input.decisionReason,
  )
}

export type LockedDeliveryStoryCdrAccessPackage = NonNullable<AssetAccessResponse["story_cdr_access"]>

export async function buildLockedDeliveryStoryCdrAccessPackage(input: {
  env: Env
  communityId: string
  subjectId: string
  userId: string
  callerWalletAddress: string
  decisionReason: "creator" | "moderator" | "purchase_entitlement"
  storyCdrVaultUuid: string | number | null
  storyNamespace: string | null
  storyEntitlementTokenId: string | null
  storyReadCondition: string | null
  lockedDeliverySecretJson: string | null
  ciphertextRef: string
  purchaseEntitlementProofMode?: "token_gate" | "signed"
}): Promise<LockedDeliveryStoryCdrAccessPackage> {
  if (!input.storyCdrVaultUuid || !input.storyNamespace || !input.lockedDeliverySecretJson) {
    throw notFoundError("Locked asset CDR metadata not found")
  }
  const chainId = resolveStoryChainId(input.env)
  const cdrContracts = resolveStoryCdrContracts(chainId)
  if (!cdrContracts) {
    throw badRequestError("Story CDR contracts are not configured for this chain")
  }
  const metadata = parseJsonValue<LockedDeliverySecret>(input.lockedDeliverySecretJson, {
    algorithm: "AES-GCM",
    iv_b64: "",
    mime_type: "application/octet-stream",
  })
  const accessScope: StoryAccessScope = input.decisionReason === "purchase_entitlement" ? "asset.share" : "asset.owner"
  const accessRef = buildStoryAccessRef({
    communityId: input.communityId,
    subjectId: input.subjectId,
    userId: input.userId,
    decisionReason: input.decisionReason,
  })
  const readConditionAddress = input.storyReadCondition || STORY_DELIVERY_CONTRACTS.signedAccessConditionV1
  const compositeReadConditionAddress = resolveStoryCompositeReadConditionAddress(input.env)
  const isTokenGateReadCondition = sameStoryAddress(readConditionAddress, STORY_DELIVERY_CONTRACTS.tokenGateCondition)
  const isCompositeReadCondition = sameStoryAddress(readConditionAddress, compositeReadConditionAddress)
  const purchaseEntitlementProofMode = input.purchaseEntitlementProofMode ?? "token_gate"
  if (
    input.decisionReason === "purchase_entitlement"
    && purchaseEntitlementProofMode === "token_gate"
    && (isTokenGateReadCondition || isCompositeReadCondition)
  ) {
    return {
      chain_id: chainId,
      rpc_url: resolveStoryRpcUrl(input.env),
      cdr_contract_address: cdrContracts.cdrAddress,
      read_condition_address: readConditionAddress,
      ciphertext_ref: input.ciphertextRef,
      cipher_algorithm: metadata.algorithm,
      cipher_iv_b64: metadata.iv_b64,
      mime_type: metadata.mime_type,
      vault_uuid: Number(input.storyCdrVaultUuid),
      namespace: input.storyNamespace,
      access_scope: accessScope,
      access_ref: accessRef,
      access_aux_data_hex: "0x",
      access_proof: {
        mode: "token_gate",
        entitlement_token_id: input.storyEntitlementTokenId,
      },
    }
  }
  if (isTokenGateReadCondition) {
    if (input.decisionReason !== "purchase_entitlement") {
      throw badRequestError("Locked asset uses token-gated CDR only; creator/moderator signed reads require the composite read condition")
    }
  }
  const accessProof = await generateStorySignedAccessProof({
    env: input.env,
    vaultUuid: Number(input.storyCdrVaultUuid),
    callerAddress: input.callerWalletAddress,
    accessRef,
    scope: accessScope,
    expiry: Math.floor(Date.now() / 1000) + 300,
    namespace: input.storyNamespace as `0x${string}`,
    verifyingContract: readConditionAddress,
  })

  return {
    chain_id: chainId,
    rpc_url: resolveStoryRpcUrl(input.env),
    cdr_contract_address: cdrContracts.cdrAddress,
    read_condition_address: readConditionAddress,
    ciphertext_ref: input.ciphertextRef,
    cipher_algorithm: metadata.algorithm,
    cipher_iv_b64: metadata.iv_b64,
    mime_type: metadata.mime_type,
    vault_uuid: Number(input.storyCdrVaultUuid),
    namespace: input.storyNamespace,
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

export async function buildStoryCdrAccessPackage(input: {
  env: Env
  asset: AssetRow
  callerWalletAddress: string
  userId: string
  decisionReason: "creator" | "moderator" | "purchase_entitlement"
  ciphertextRef?: string
}): Promise<NonNullable<AssetAccessResponse["story_cdr_access"]>> {
  return await buildLockedDeliveryStoryCdrAccessPackage({
    env: input.env,
    communityId: input.asset.community_id,
    subjectId: input.asset.asset_id,
    userId: input.userId,
    decisionReason: input.decisionReason,
    callerWalletAddress: input.callerWalletAddress,
    storyCdrVaultUuid: input.asset.story_cdr_vault_uuid,
    storyNamespace: input.asset.story_namespace,
    storyEntitlementTokenId: input.asset.story_entitlement_token_id,
    storyReadCondition: input.asset.story_read_condition,
    lockedDeliverySecretJson: input.asset.locked_delivery_secret_json,
    ciphertextRef: input.ciphertextRef ?? buildAssetContentPath(input.asset.community_id, input.asset.asset_id),
  })
}

export async function prepareLockedAssetDelivery(input: {
  env: Env
  communityId: string
  assetId: string
  creatorWalletAddress: string
  storageRef: string
  mimeType: string
  contentHash: string | null
  artifactKind: SongArtifactUpload["artifact_kind"]
  bundleId: string | null
  rightsBasis: Post["rights_basis"]
  upstreamAssetRefs: string[] | null
  preparedDelivery?: PreparedLockedDeliveryCoordinates | null
  onPreparedDelivery?: (prepared: PreparedLockedDeliveryCoordinates) => Promise<void>
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
  if (testLockedAssetDeliveryPreparer) {
    return await testLockedAssetDeliveryPreparer(input)
  }

  const controlPlaneClient = getControlPlaneClient(input.env)
  const upload = await findUploadedSongArtifactByStorageRef({
    client: controlPlaneClient,
    communityId: input.communityId,
    storageRef: input.storageRef,
    artifactKind: input.artifactKind,
  })
  if (!upload?.storage_object_key) {
    throw badRequestError("Primary asset upload is missing locked-delivery storage metadata")
  }
  const uploadObjectKey = upload.storage_object_key

  const objectKey = `locked-assets/${input.communityId}/${input.assetId}/payload.bin`
  let plaintext: Uint8Array<ArrayBuffer> | null = null
  async function getPlaintext(): Promise<Uint8Array<ArrayBuffer>> {
    if (plaintext) return plaintext
    const upstream = await fetchSongArtifactBytes({
      env: input.env,
      objectKey: uploadObjectKey,
    })
    plaintext = new Uint8Array(await upstream.arrayBuffer())
    return plaintext
  }
  const primaryContentHash = (input.contentHash?.trim() || `0x${await sha256Hex(await getPlaintext())}`) as `0x${string}`
  const assetVersionId = deriveStoryAssetVersionId({
    communityId: input.communityId,
    assetId: input.assetId,
    bundleId: input.bundleId ?? input.storageRef,
    primaryContentHash,
  })
  const namespace = deriveStoryNamespace(assetVersionId)
  const entitlementTokenId = deriveEntitlementTokenId(assetVersionId)
  const readConditionAddress = resolveStoryCompositeReadConditionAddress(input.env)
    ?? STORY_DELIVERY_CONTRACTS.tokenGateCondition
  const writeConditionAddress = STORY_DELIVERY_CONTRACTS.signedAccessConditionV1
  const lockedDeliveryRef = buildAssetContentPath(input.communityId, input.assetId)
  let fallbackLockedDeliveryMetadataJson = JSON.stringify({
    algorithm: "AES-GCM",
    iv_b64: "",
    mime_type: input.mimeType,
  } satisfies LockedDeliverySecret)
  const storyPublishRightsBasis = input.rightsBasis === "original" || input.rightsBasis === "derivative"
    ? input.rightsBasis
    : "none"
  try {
    const cdrWriterMinimumBalanceWei = await estimateStoryCdrLockedPublishMinimumBalanceWei(input.env)
    const storyOperatorMinimumBalanceWei = resolveStoryRuntimeSignerTargetBalanceWei(input.env)
    await assertStoryRuntimeSignerFunding(input.env, [
      { name: "story-cdr-writer", minBalanceWei: cdrWriterMinimumBalanceWei },
      { name: "story-operator", minBalanceWei: storyOperatorMinimumBalanceWei },
    ])
    let cdrVaultUuid: number
    let lockedDeliveryStorageRef = objectKey
    let lockedDeliveryMetadataJson: string
    const prepared = input.preparedDelivery
    if (
      prepared
      && prepared.storyAssetVersionId === assetVersionId
      && prepared.storyCdrVaultUuid > 0
      && prepared.storyNamespace === namespace
      && prepared.storyEntitlementTokenId === entitlementTokenId.toString()
      && prepared.storyReadCondition === readConditionAddress
      && prepared.storyWriteCondition === writeConditionAddress
      && prepared.lockedDeliveryRef === lockedDeliveryRef
      && prepared.lockedDeliveryStorageRef.trim()
      && prepared.lockedDeliveryMetadataJson.trim()
    ) {
      cdrVaultUuid = prepared.storyCdrVaultUuid
      lockedDeliveryStorageRef = prepared.lockedDeliveryStorageRef
      lockedDeliveryMetadataJson = prepared.lockedDeliveryMetadataJson
    } else {
      const plaintext = await getPlaintext()
      if (plaintext.byteLength > 50 * 1024 * 1024) {
        console.warn(`[story] locked asset ${input.assetId} is ${plaintext.byteLength} bytes; chunked encryption should replace whole-payload encryption before raising size caps`)
      }
      const { ciphertext, dataKey, metadata } = await encryptLockedPayload(plaintext)
      metadata.mime_type = input.mimeType
      lockedDeliveryMetadataJson = JSON.stringify(metadata)
      fallbackLockedDeliveryMetadataJson = lockedDeliveryMetadataJson
      await uploadFilebaseObject({
        env: input.env,
        objectKey,
        mimeType: "application/octet-stream",
        bytes: ciphertext,
      })
      const writerConfig = resolveStoryCdrWriterDirectSigner(input.env)
      if (!writerConfig.ok) {
        throw badRequestError(writerConfig.error)
      }
      if (!writerConfig.value) {
        throw badRequestError("STORY_CDR_WRITER_PRIVATE_KEY missing/invalid")
      }
      const readConditionData = sameStoryAddress(readConditionAddress, STORY_DELIVERY_CONTRACTS.tokenGateCondition)
        ? encodeTokenGateConditionData({
          entitlementTokenAddress: STORY_DELIVERY_CONTRACTS.purchaseEntitlementToken,
          tokenId: entitlementTokenId,
          minBalance: 1n,
        })
        : encodeCompositeReadConditionData({
          entitlementTokenAddress: STORY_DELIVERY_CONTRACTS.purchaseEntitlementToken,
          tokenId: entitlementTokenId,
          minBalance: 1n,
          namespace,
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
        throw new Error(`cdr_write_failed:${formatCdrWriteFailure(error, input.env)}`)
      }
      cdrVaultUuid = cdrUpload.cdrVaultUuid
      await input.onPreparedDelivery?.({
        storyAssetVersionId: assetVersionId,
        storyCdrVaultUuid: cdrVaultUuid,
        storyNamespace: namespace,
        storyEntitlementTokenId: entitlementTokenId.toString(),
        storyReadCondition: readConditionAddress,
        storyWriteCondition: writeConditionAddress,
        lockedDeliveryRef,
        lockedDeliveryStorageRef,
        lockedDeliveryMetadataJson,
      })
    }
    let storyPublish: Awaited<ReturnType<typeof publishLockedAssetVersionToStory>>
    try {
      storyPublish = await publishLockedAssetVersionToStory({
        env: input.env,
        publisherAddress: input.creatorWalletAddress,
        assetVersionId,
        cdrVaultUuid,
        namespace,
        contentHash: primaryContentHash,
        storageRefHash: deriveStorageRefHash(lockedDeliveryStorageRef),
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
      storyCdrVaultUuid: cdrVaultUuid,
      storyNamespace: namespace,
      storyEntitlementTokenId: entitlementTokenId.toString(),
      storyReadCondition: readConditionAddress,
      storyWriteCondition: writeConditionAddress,
      lockedDeliveryStatus: "ready",
      lockedDeliveryRef,
      lockedDeliveryStorageRef,
      lockedDeliveryMetadataJson,
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
        lockedDeliveryRef,
        lockedDeliveryStorageRef: objectKey,
        lockedDeliveryMetadataJson: fallbackLockedDeliveryMetadataJson,
      }
    }
    throw error instanceof Error ? error : new Error(errorMessage)
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
}): Promise<Awaited<ReturnType<typeof prepareLockedAssetDelivery>>> {
  return await prepareLockedAssetDelivery({
    env: input.env,
    communityId: input.communityId,
    assetId: input.assetId,
    creatorWalletAddress: input.creatorWalletAddress,
    storageRef: input.bundle.primary_audio.storage_ref,
    mimeType: input.bundle.primary_audio.mime_type,
    contentHash: input.bundle.primary_audio.content_hash ?? null,
    artifactKind: "primary_audio",
    bundleId: input.bundle.id.replace(/^sab_/, ""),
    rightsBasis: input.rightsBasis,
    upstreamAssetRefs: input.upstreamAssetRefs,
  })
}

export async function fetchPrimaryAssetContent(input: {
  env: Env
  communityId: string
  storageRef: string
}): Promise<Response> {
  const controlPlaneClient = getControlPlaneClient(input.env)
  const upload = await findUploadedSongArtifactByStorageRef({
    client: controlPlaneClient,
    communityId: input.communityId,
    storageRef: input.storageRef,
  })
  if (!upload?.storage_object_key) {
    throw notFoundError("Primary asset content not found")
  }
  return await fetchSongArtifactBytes({
    env: input.env,
    objectKey: upload.storage_object_key,
  })
}
