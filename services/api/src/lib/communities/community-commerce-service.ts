import type { Client } from "../sql-client"
import { AbiCoder } from "ethers"
import { badRequestError, notFoundError } from "../errors"
import { isLocalEnvironment, nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import { getCommunityMembershipState } from "./community-membership-store"
import { openCommunityDb } from "./community-db-factory"
import type { CommunityRepository } from "./db-community-repository"
import { getPostById } from "../posts/community-post-store"
import {
  fetchSongArtifactBytes,
  sha256Hex,
  uploadFilebaseObject,
} from "../song-artifacts/song-artifact-storage"
import { findUploadedSongArtifactByStorageRef } from "../song-artifacts/song-artifact-repository"
import type { UserRepository } from "../auth/repositories"
import {
  generateStorySignedAccessProof,
  type StoryAccessScope,
} from "../story/story-access-proof-service"
import {
  deriveEntitlementTokenId,
  deriveStorageRefHash,
  deriveStoryAssetVersionId,
  deriveStoryNamespace,
  encodeTokenGateConditionData,
  hashBytes32FromParts,
  encodeWriteConditionOperatorData,
} from "../story/story-identifiers"
import {
  estimateStoryCdrLockedPublishMinimumBalanceWei,
  resolveStoryCdrContracts,
  uploadCdrEncryptedDataKey,
} from "../story/story-cdr"
import { resolveStoryCdrWriterDirectSigner } from "../story/story-direct-signer"
import { publishLockedAssetVersionToStory } from "../story/story-publish-service"
import { assertStoryRuntimeSignerFunding } from "../story/story-runtime-funding"
import {
  resolveStoryChainId,
  resolveStoryRpcUrl,
  STORY_DELIVERY_CONTRACTS,
} from "../story/story-runtime-config"
import {
  type AssetRow,
  buildAssetContentPath,
  getActiveEntitlementForBuyer,
  getAssetRow,
  parseJsonValue,
  requireCommunityMember,
  resolvePrimaryWalletAddress,
  serializeAsset,
} from "./community-commerce-shared"
import type {
  Asset,
  AssetAccessResponse,
  Env,
  Post,
  SongArtifactBundle,
} from "../../types"

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

async function buildStoryCdrAccessPackage(input: {
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

async function prepareLockedSongAssetDelivery(input: {
  env: Env
  communityId: string
  assetId: string
  creatorWalletAddress: string
  bundle: SongArtifactBundle
}): Promise<{
  storyStatus: Asset["story_status"]
  storyPublishTxRef: string
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
      })
    } catch (error) {
      throw new Error(`story_publish_failed:${error instanceof Error ? error.message : String(error)}`)
    }

    return {
      storyStatus: "published",
      storyPublishTxRef: storyPublish.publishTxHash,
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

async function fetchPrimarySongAssetContent(input: {
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

export async function createSongAssetForPost(input: {
  env: Env
  client: Client
  communityId: string
  post: Post
  bundle: SongArtifactBundle
  userRepository: UserRepository
}): Promise<Asset> {
  if (!input.post.asset_id?.trim()) {
    throw badRequestError("Song post is missing asset_id")
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
  let storyStatus: Asset["story_status"] = "none"
  let storyError: string | null = null
  let storyPublishTxRef: string | null = null
  let storyAssetVersionId: string | null = null
  let storyCdrVaultUuid: number | null = null
  let storyNamespace: string | null = null
  let storyEntitlementTokenId: string | null = null
  let storyReadCondition: string | null = null
  let storyWriteCondition: string | null = null

  if ((input.post.access_mode ?? "public") === "locked") {
    try {
      const creatorWalletAddress = await resolvePrimaryWalletAddress({
        env: input.env,
        userRepository: input.userRepository,
        userId: input.post.author_user_id ?? "",
      })
      const lockedDelivery = await prepareLockedSongAssetDelivery({
        env: input.env,
        communityId: input.communityId,
        assetId: input.post.asset_id,
        creatorWalletAddress,
        bundle: input.bundle,
      })
      storyStatus = lockedDelivery.storyStatus
      storyPublishTxRef = lockedDelivery.storyPublishTxRef
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
      lockedDeliveryStatus = "failed"
      lockedDeliveryError = storyError
      throw badRequestError(`Locked delivery preparation failed: ${lockedDeliveryError}`)
    }
  }

  await input.client.execute({
    sql: `
      INSERT INTO assets (
        asset_id, community_id, source_post_id, song_artifact_bundle_id, creator_user_id, asset_kind,
        rights_basis, access_mode, primary_content_ref, primary_content_hash, publication_status,
        story_status, story_error, story_ip_id, locked_delivery_status, locked_delivery_ref,
        locked_delivery_error, created_at, updated_at, story_publish_tx_ref, story_asset_version_id,
        story_cdr_vault_uuid, story_namespace, story_entitlement_token_id, story_read_condition,
        story_write_condition, locked_delivery_storage_ref, locked_delivery_secret_json
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, 'song_audio',
        ?6, ?7, ?8, ?9, 'draft',
        ?10, ?11, NULL, ?12, ?13,
        ?14, ?15, ?15, ?16, ?17,
        ?18, ?19, ?20, ?21, ?22,
        ?23, ?24
      )
    `,
    args: [
      input.post.asset_id,
      input.communityId,
      input.post.post_id,
      input.post.song_artifact_bundle_id ?? null,
      input.post.author_user_id ?? "",
      input.post.rights_basis ?? "none",
      input.post.access_mode ?? "public",
      input.bundle.primary_audio.storage_ref,
      input.bundle.primary_audio.content_hash ?? `0x${await sha256Hex(input.bundle.primary_audio.storage_ref)}`,
      storyStatus,
      storyError,
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

export async function getCommunityAsset(input: {
  env: Env
  userId: string
  communityId: string
  assetId: string
  communityRepository: CommunityRepository
}): Promise<Asset> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const asset = await getAssetRow(db.client, input.communityId, input.assetId)
    if (!asset) {
      throw notFoundError("Asset not found")
    }
    const post = await getPostById(db.client, asset.source_post_id)
    const isPrivilegedViewer = asset.creator_user_id === input.userId
      || (await getCommunityMembershipState(db.client, input.communityId, input.userId)).role_status === "active"
    if (!post) {
      throw notFoundError("Asset not found")
    }
    if (post.status !== "published" && !isPrivilegedViewer) {
      throw notFoundError("Asset not found")
    }
    return serializeAsset(asset, { redactPrimaryForLocked: !isPrivilegedViewer })
  } finally {
    db.close()
  }
}

export async function resolveCommunityAssetAccess(input: {
  env: Env
  userId: string
  communityId: string
  assetId: string
  communityRepository: CommunityRepository
  userRepository: UserRepository
}): Promise<AssetAccessResponse> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireCommunityMember(db.client, input.communityId, input.userId)
    const asset = await getAssetRow(db.client, input.communityId, input.assetId)
    if (!asset) {
      throw notFoundError("Asset not found")
    }
    const post = await getPostById(db.client, asset.source_post_id)
    const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
    const isPrivilegedViewer = asset.creator_user_id === input.userId || membership.role_status === "active"
    if (!post) {
      throw notFoundError("Asset not found")
    }
    if (post.status !== "published" && !isPrivilegedViewer) {
      throw notFoundError("Asset not found")
    }

    if (asset.access_mode === "public") {
      return {
        asset_id: asset.asset_id,
        community_id: asset.community_id,
        source_post_id: asset.source_post_id,
        access_mode: asset.access_mode,
        source_post_status: post.status === "draft" || post.status === "hidden" ? post.status : "published",
        story_status: asset.story_status,
        locked_delivery_status: asset.locked_delivery_status,
        access_granted: true,
        decision_reason: isPrivilegedViewer ? "creator" : "public",
        delivery_kind: "primary_content_ref",
        delivery_ref: buildAssetContentPath(asset.community_id, asset.asset_id),
        story_cdr_access: null,
      }
    }

    if (isPrivilegedViewer) {
      const callerWalletAddress = await resolvePrimaryWalletAddress({
        env: input.env,
        userRepository: input.userRepository,
        userId: input.userId,
      })
      const decisionReason = membership.role_status === "active" && asset.creator_user_id !== input.userId ? "moderator" : "creator"
      return {
        asset_id: asset.asset_id,
        community_id: asset.community_id,
        source_post_id: asset.source_post_id,
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
        asset_id: asset.asset_id,
        community_id: asset.community_id,
        source_post_id: asset.source_post_id,
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
      asset_id: asset.asset_id,
      community_id: asset.community_id,
      source_post_id: asset.source_post_id,
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

export async function fetchCommunityAssetContent(input: {
  env: Env
  userId: string
  communityId: string
  assetId: string
  communityRepository: CommunityRepository
  userRepository: UserRepository
}): Promise<Response> {
  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    const asset = await getAssetRow(db.client, input.communityId, input.assetId)
    if (!asset) {
      throw notFoundError("Asset not found")
    }
    const post = await getPostById(db.client, asset.source_post_id)
    const membership = await getCommunityMembershipState(db.client, input.communityId, input.userId)
    const isPrivilegedViewer = asset.creator_user_id === input.userId || membership.role_status === "active"
    if (!post) {
      throw notFoundError("Asset not found")
    }
    if (post.status !== "published" && !isPrivilegedViewer) {
      throw notFoundError("Asset content not found")
    }
    if (asset.access_mode === "public" || !asset.locked_delivery_storage_ref) {
      return await fetchPrimarySongAssetContent({
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

export * from "./community-commerce-policy-service"
export * from "./community-commerce-purchase-service"
