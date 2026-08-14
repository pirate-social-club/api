import {
  CONTENT_SOURCE_STORAGE_NAMESPACE,
  contentSourceObjectKey,
} from "@pirate/content-source-protocol"
import type { Env } from "../../env"
import { openCommunityReadClient } from "../communities/community-read-access"
import {
  requireActiveCommunity,
  requireMemberAccess,
} from "../communities/community-content-access"
import type { CommunityReadRepository } from "../communities/db-community-repository"
import type { CommunityDatabaseBindingRepository } from "../communities/community-repository-types"
import { sha256Hex } from "../crypto"
import {
  dispatchContentSecurityScanJob,
  prepareInitialContentSecurityScan,
} from "../content-security/content-security-queue"
import { badRequestError, conflictError, notFoundError } from "../errors"
import { envFlag, genericDigitalGoodsEnabled, makeId, nowIso, splitCsv } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import {
  beginProxyContentUpload,
  createContentBlobIntent,
  markProxyContentBlobUploaded,
  releaseProxyContentUpload,
  requireOwnedContentBlob,
} from "./content-blob-repository"
import {
  assertCreateContentBlobRequest,
  CONTENT_BLOB_PROXY_MAX_BYTES,
  normalizeContentHash,
  normalizeFilename,
  normalizeMimeType,
  type CreateContentBlobRequest,
} from "./content-blob-policy"
import { serializeContentBlob, type ContentBlob } from "./content-blob-serialization"
import {
  assertContentSourceBrokerConfigured,
  CONTENT_SOURCE_STORAGE_ENDPOINT,
  storeContentSource,
} from "./content-source-broker-client"
import { assertGenericEmergencyControlsClear } from "../communities/commerce/generic-asset-emergency-controls"

const CONTENT_BLOB_SESSION_TTL_MS = 60 * 60 * 1000
type ContentBlobCommunityRepository = CommunityReadRepository & CommunityDatabaseBindingRepository


function addMilliseconds(iso: string, milliseconds: number): string {
  return new Date(new Date(iso).getTime() + milliseconds).toISOString()
}

function buildContentBlobContentUrl(origin: string, communityId: string, contentBlobId: string): string {
  return new URL(
    `/communities/${encodeURIComponent(communityId)}/content-blobs/${encodeURIComponent(contentBlobId)}/content`,
    origin,
  ).toString()
}

function requireContentBlobUploadsEnabled(env: Env, communityId: string): void {
  const allowedCommunities = new Set(
    splitCsv(env.CONTENT_BLOB_UPLOAD_COMMUNITY_IDS).map((value) => value.replace(/^com_/, "")),
  )
  if (
    !genericDigitalGoodsEnabled(env)
    || !envFlag(env.CONTENT_BLOB_UPLOADS_ENABLED, false)
    || !allowedCommunities.has(communityId)
  ) {
    throw notFoundError("Content blob uploads are not enabled")
  }
}

async function requireCommunityMember(input: {
  env: Env
  communityRepository: ContentBlobCommunityRepository
  communityId: string
  userId: string
}): Promise<void> {
  await requireActiveCommunity(input.communityRepository, input.communityId)
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    await requireMemberAccess(db.client, input.communityId, input.userId)
  } finally {
    db.close()
  }
}

export async function createContentBlob(input: {
  env: Env
  userId: string
  communityId: string
  body: CreateContentBlobRequest
  communityRepository: ContentBlobCommunityRepository
  origin: string
}): Promise<ContentBlob> {
  requireContentBlobUploadsEnabled(input.env, input.communityId)
  assertContentSourceBrokerConfigured(input.env)
  assertCreateContentBlobRequest(input.body)
  await assertGenericEmergencyControlsClear({
    client: getControlPlaneClient(input.env),
    context: {
      communityId: input.communityId,
      uploaderUserId: input.userId,
      validationProfile: input.body.validation_profile.trim(),
    },
    notFoundMessage: "Content blob uploads are not enabled",
  })
  await requireCommunityMember(input)

  const now = nowIso()
  const contentBlobId = makeId("cbl")
  const owned = await createContentBlobIntent({
    client: getControlPlaneClient(input.env),
    intent: {
      contentBlobId,
      contentUploadSessionId: makeId("cus"),
      communityId: input.communityId,
      uploaderUserId: input.userId,
      validationProfile: input.body.validation_profile.trim(),
      declaredFilename: normalizeFilename(input.body.declared_filename),
      declaredMimeType: normalizeMimeType(input.body.declared_mime_type),
      declaredSizeBytes: input.body.declared_size_bytes ?? null,
      declaredContentHash: normalizeContentHash(input.body.declared_content_hash),
      storageRef: buildContentBlobContentUrl(input.origin, input.communityId, contentBlobId),
      uploadMode: input.body.upload_mode,
      objectKey: contentSourceObjectKey(contentBlobId),
      providerUploadId: null,
      partSizeBytes: null,
      totalParts: null,
      bucket: CONTENT_SOURCE_STORAGE_NAMESPACE,
      storageEndpoint: CONTENT_SOURCE_STORAGE_ENDPOINT,
      expiresAt: addMilliseconds(now, CONTENT_BLOB_SESSION_TTL_MS),
      createdAt: now,
    },
  })
  return serializeContentBlob(owned)
}

export async function getOwnedContentBlob(input: {
  env: Env
  userId: string
  communityId: string
  contentBlobId: string
  communityRepository: ContentBlobCommunityRepository
}): Promise<ContentBlob> {
  requireContentBlobUploadsEnabled(input.env, input.communityId)
  await requireCommunityMember(input)
  const owned = await requireOwnedContentBlob({
    client: getControlPlaneClient(input.env),
    communityId: input.communityId,
    uploaderUserId: input.userId,
    contentBlobId: input.contentBlobId,
  })
  return serializeContentBlob(owned)
}

function normalizeUploadBytes(content: ArrayBuffer | Uint8Array): Uint8Array<ArrayBuffer> {
  if (content instanceof ArrayBuffer) return new Uint8Array(content)
  if (
    content.buffer instanceof ArrayBuffer
    && content.byteOffset === 0
    && content.byteLength === content.buffer.byteLength
  ) {
    return content as Uint8Array<ArrayBuffer>
  }
  return new Uint8Array(content)
}

export async function uploadContentBlobBytes(input: {
  env: Env
  userId: string
  communityId: string
  contentBlobId: string
  content: ArrayBuffer | Uint8Array
  communityRepository: ContentBlobCommunityRepository
}): Promise<ContentBlob> {
  requireContentBlobUploadsEnabled(input.env, input.communityId)
  await requireCommunityMember(input)
  const client = getControlPlaneClient(input.env)
  const owned = await requireOwnedContentBlob({
    client,
    communityId: input.communityId,
    uploaderUserId: input.userId,
    contentBlobId: input.contentBlobId,
  })
  if (owned.blob.status === "uploaded") {
    return serializeContentBlob(owned)
  }
  const session = owned.uploadSession
  if (owned.blob.status !== "pending_upload" || !session || session.upload_mode !== "proxy") {
    throw badRequestError("Content blob is not ready for proxy upload")
  }
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    throw badRequestError("Content upload session expired")
  }

  const bytes = normalizeUploadBytes(input.content)
  if (bytes.byteLength < 1) {
    throw badRequestError("Content blob content is required")
  }
  if (bytes.byteLength > CONTENT_BLOB_PROXY_MAX_BYTES) {
    throw badRequestError("Proxy content blobs are limited to 50 MiB")
  }
  if (owned.blob.declared_size_bytes != null && owned.blob.declared_size_bytes !== bytes.byteLength) {
    throw badRequestError("Uploaded byte count does not match declared_size_bytes")
  }
  const hashHex = await sha256Hex(bytes)
  const contentHash = `0x${hashHex}`
  if (owned.blob.declared_content_hash && owned.blob.declared_content_hash !== contentHash) {
    throw badRequestError("Uploaded bytes do not match declared_content_hash")
  }
  const scanJob = await prepareInitialContentSecurityScan({
    env: input.env,
    client,
    scanJobId: makeId("csj"),
  })

  const locked = await beginProxyContentUpload({
    client,
    communityId: input.communityId,
    uploaderUserId: input.userId,
    contentBlobId: input.contentBlobId,
    contentUploadSessionId: session.content_upload_session_id,
    updatedAt: nowIso(),
  })
  if (!locked) {
    throw conflictError("Content upload is already in progress")
  }

  try {
    const storage = await storeContentSource({
      env: input.env,
      contentBlobId: input.contentBlobId,
      bytes,
      sha256: hashHex,
    })
    const completedAt = nowIso()
    const uploaded = await markProxyContentBlobUploaded({
      client,
      communityId: input.communityId,
      uploaderUserId: input.userId,
      contentBlobId: input.contentBlobId,
      contentUploadSessionId: session.content_upload_session_id,
      verifiedSizeBytes: bytes.byteLength,
      verifiedContentHash: storage.contentHash,
      storageProvider: storage.storageProvider,
      storageBucket: storage.storageBucket,
      storageObjectKey: storage.storageObjectKey,
      storageEndpoint: storage.storageEndpoint,
      gatewayUrl: null,
      ipfsCid: null,
      completedAt,
      scanJob: scanJob ?? undefined,
    })
    if (scanJob) {
      await dispatchContentSecurityScanJob({
        env: input.env,
        client,
        scanJobId: scanJob.scanJobId,
        dispatchedAt: nowIso(),
      })
    }
    return serializeContentBlob(uploaded)
  } catch (error) {
    await releaseProxyContentUpload({
      client,
      uploaderUserId: input.userId,
      contentBlobId: input.contentBlobId,
      contentUploadSessionId: session.content_upload_session_id,
      updatedAt: nowIso(),
    }).catch(() => undefined)
    throw error
  }
}
