import { openCommunityReadClient } from "../communities/community-read-access"
import { badRequestError, conflictError, HttpError, notFoundError } from "../errors"
import { resolveFilebaseConfig } from "../storage/filebase-config"
import {
  abortMultipartUpload,
  buildUploadPartPresignedUrl,
  completeMultipartUpload,
  createMultipartUpload,
  headObject,
  type CompletedMultipartPart,
} from "../storage/filebase-multipart"
import { makeId, nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import {
  createSongArtifactUploadIntent,
  markSongArtifactUploadCancelled,
  markSongArtifactUploadUploaded,
  requireSongArtifactUpload,
} from "./song-artifact-repository"
import {
  buildSongArtifactContentUrl,
  buildSongArtifactObjectKey,
  assertSongArtifactMimeType,
  assertSongArtifactSize,
  type SongArtifactKind,
} from "./song-artifact-storage"
import { requireActiveCommunity, requireMemberAccess } from "./song-artifact-access"
import {
  createSongArtifactUploadSession,
  listStaleSongArtifactUploadSessions,
  markSongArtifactUploadSessionAborted,
  markSongArtifactUploadSessionUploaded,
  requireSongArtifactUploadSession,
  transitionSongArtifactUploadSession,
  type SongArtifactUploadSessionRow,
} from "./song-artifact-upload-session-repository"
import { FILEBASE_SONG_ARTIFACT_STORAGE_PROVIDER } from "./song-artifact-storage-provider"
import type { Env } from "../../env"
import type { CreateSongArtifactUploadRequest, SongArtifactUpload } from "../../types"
import type { SongArtifactCommunityRepository } from "./song-artifact-types"

const DIRECT_MULTIPART_PART_BYTES = 10 * 1024 * 1024
const DIRECT_MULTIPART_SESSION_TTL_MS = 60 * 60 * 1000
const DIRECT_MULTIPART_PART_URL_TTL_SECONDS = 300
export const DIRECT_MULTIPART_MAX_BYTES = 2 * 1024 * 1024 * 1024
const MAX_MULTIPART_PARTS = 10_000
const POST_COMPLETE_HEAD_RETRY_DELAYS_MS = [1000, 2000, 4000, 8000, 16000] as const
const DIRECT_MULTIPART_ARTIFACT_KINDS = new Set<SongArtifactKind>([
  "primary_audio",
  "preview_audio",
  "instrumental_audio",
  "vocal_audio",
  "primary_video",
  "preview_video",
  "canvas_video",
])

export type SongArtifactMultipartUploadSessionDescriptor = {
  id: string
  status: SongArtifactUploadSessionRow["status"]
  object_key: string
  upload_id: string
  part_size_bytes: number
  total_parts: number
  expires_at: string
  sign_part_url: string
  complete: string
  abort: string
}

export type CreateMultipartSongArtifactUploadResult = SongArtifactUpload & {
  upload_session: SongArtifactMultipartUploadSessionDescriptor
}

function addMilliseconds(iso: string, milliseconds: number): string {
  return new Date(new Date(iso).getTime() + milliseconds).toISOString()
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function computeMultipartPartPlan(totalSizeBytes: number): { partSizeBytes: number; totalParts: number } {
  if (!Number.isSafeInteger(totalSizeBytes) || totalSizeBytes <= 0) {
    throw badRequestError("direct_multipart upload requires a positive size_bytes")
  }
  if (totalSizeBytes > DIRECT_MULTIPART_MAX_BYTES) {
    throw badRequestError("Direct multipart uploads are currently limited to 2GB")
  }
  const totalParts = Math.max(1, Math.ceil(totalSizeBytes / DIRECT_MULTIPART_PART_BYTES))
  if (totalParts > MAX_MULTIPART_PARTS) {
    throw badRequestError("direct_multipart upload exceeds the maximum part count")
  }
  return {
    partSizeBytes: DIRECT_MULTIPART_PART_BYTES,
    totalParts,
  }
}

function normalizeContentHash(value: string | null | undefined): string | null {
  const trimmed = value?.trim() || null
  if (!trimmed) return null
  if (!/^0x[a-f0-9]{64}$/i.test(trimmed)) {
    throw badRequestError("content_hash must be a SHA-256 hex digest with 0x prefix")
  }
  return trimmed.toLowerCase()
}

function assertDirectMultipartRequest(body: CreateSongArtifactUploadRequest): void {
  const kind = body.artifact_kind as SongArtifactKind
  if (!DIRECT_MULTIPART_ARTIFACT_KINDS.has(kind)) {
    throw badRequestError("direct_multipart is only supported for audio and video artifacts")
  }
  const mimeType = body.mime_type.trim().toLowerCase()
  if (!mimeType) {
    throw badRequestError("mime_type is required")
  }
  assertSongArtifactMimeType(kind, mimeType)
  if (kind !== "primary_video") {
    assertSongArtifactSize(kind, body.size_bytes ?? 0)
  }
  computeMultipartPartPlan(body.size_bytes ?? 0)
}

function encodeRoute(value: string): string {
  return encodeURIComponent(value)
}

function sessionDescriptor(input: {
  origin: string
  communityId: string
  songArtifactUploadId: string
  session: SongArtifactUploadSessionRow
}): SongArtifactMultipartUploadSessionDescriptor {
  const uploadId = input.session.filebase_upload_id
  const partSizeBytes = input.session.part_size_bytes
  const totalParts = input.session.total_parts
  if (!uploadId || partSizeBytes == null || totalParts == null) {
    throw badRequestError("Song artifact upload session is not ready for multipart upload")
  }
  const basePath = `/communities/${encodeRoute(input.communityId)}/song-artifact-uploads/${encodeRoute(input.songArtifactUploadId)}/sessions/${encodeRoute(input.session.song_artifact_upload_session_id)}`
  return {
    id: input.session.song_artifact_upload_session_id,
    status: input.session.status,
    object_key: input.session.object_key,
    upload_id: uploadId,
    part_size_bytes: partSizeBytes,
    total_parts: totalParts,
    expires_at: input.session.expires_at,
    sign_part_url: new URL(`${basePath}/parts/{part_number}/signed-url`, input.origin).toString(),
    complete: new URL(`${basePath}/complete`, input.origin).toString(),
    abort: new URL(`${basePath}/abort`, input.origin).toString(),
  }
}

async function requireOwnedSession(input: {
  env: Env
  userId: string
  communityId: string
  songArtifactUploadId: string
  sessionId: string
  communityRepository: SongArtifactCommunityRepository
}): Promise<SongArtifactUploadSessionRow> {
  await requireActiveCommunity(input.communityRepository, input.communityId)
  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    await requireMemberAccess(db.client, input.communityId, input.userId)
  } finally {
    db.close()
  }

  const session = await requireSongArtifactUploadSession({
    client: getControlPlaneClient(input.env),
    communityId: input.communityId,
    sessionId: input.sessionId,
  })
  if (session.song_artifact_upload_id !== input.songArtifactUploadId || session.uploader_user_id !== input.userId) {
    throw notFoundError("Song artifact upload session not found")
  }
  return session
}

function validateCompletedParts(input: {
  session: SongArtifactUploadSessionRow
  parts: ReadonlyArray<CompletedMultipartPart>
}): void {
  const totalParts = input.session.total_parts
  if (totalParts == null || totalParts < 1) {
    throw badRequestError("Song artifact upload session has no multipart part plan")
  }
  if (input.parts.length < 1 || input.parts.length > MAX_MULTIPART_PARTS) {
    throw badRequestError("Invalid multipart part count")
  }
  if (input.parts.length !== totalParts) {
    throw badRequestError("Multipart completion part count does not match the upload session")
  }
  const seen = new Set<number>()
  for (const part of input.parts) {
    if (!Number.isSafeInteger(part.partNumber) || part.partNumber < 1 || part.partNumber > totalParts) {
      throw badRequestError("Invalid multipart part number")
    }
    if (seen.has(part.partNumber)) {
      throw badRequestError("Duplicate multipart part number")
    }
    seen.add(part.partNumber)
    if (!/^"[a-f0-9]{32}"$/i.test(part.etag.trim())) {
      throw badRequestError("Invalid multipart part ETag")
    }
  }
}

function normalizeHeadContentType(contentType: string | null): string | null {
  return contentType?.split(";")[0]?.trim().toLowerCase() || null
}

function isRetryableHeadVerificationError(error: unknown): boolean {
  return error instanceof HttpError
    && (error.code === "provider_unavailable" || error.code === "not_found")
}

async function headObjectAfterComplete(input: {
  env: Env
  objectKey: string
}): ReturnType<typeof headObject> {
  let lastError: unknown = null
  for (let attempt = 0; attempt <= POST_COMPLETE_HEAD_RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      return await headObject(input)
    } catch (error) {
      lastError = error
      if (!isRetryableHeadVerificationError(error) || attempt >= POST_COMPLETE_HEAD_RETRY_DELAYS_MS.length) {
        throw error
      }
      await sleep(POST_COMPLETE_HEAD_RETRY_DELAYS_MS[attempt]!)
    }
  }
  throw lastError
}

export async function createMultipartSongArtifactUpload(input: {
  env: Env
  userId: string
  communityId: string
  body: CreateSongArtifactUploadRequest
  communityRepository: SongArtifactCommunityRepository
  origin: string
}): Promise<CreateMultipartSongArtifactUploadResult> {
  assertDirectMultipartRequest(input.body)
  await requireActiveCommunity(input.communityRepository, input.communityId)

  const db = await openCommunityReadClient(input.env, input.communityRepository, input.communityId)
  try {
    await requireMemberAccess(db.client, input.communityId, input.userId)
  } finally {
    db.close()
  }

  const client = getControlPlaneClient(input.env)
  const now = nowIso()
  const songArtifactUploadId = makeId("sau")
  const contentHash = normalizeContentHash(input.body.content_hash)
  const mimeType = input.body.mime_type.trim().toLowerCase()
  const partPlan = computeMultipartPartPlan(input.body.size_bytes ?? 0)
  const objectKey = buildSongArtifactObjectKey(
    input.communityId,
    songArtifactUploadId,
    input.body.artifact_kind as SongArtifactKind,
    mimeType,
  )
  const upload = await createSongArtifactUploadIntent({
    client,
    communityId: input.communityId,
    userId: input.userId,
    songArtifactUploadId,
    storageRef: buildSongArtifactContentUrl(input.origin, input.communityId, songArtifactUploadId),
    body: {
      ...input.body,
      mime_type: mimeType,
      content_hash: contentHash,
    },
    createdAt: now,
  })

  let filebaseUploadId: string | null = null
  try {
    filebaseUploadId = (await createMultipartUpload({
      env: input.env,
      objectKey,
      mimeType,
    })).uploadId
    const config = resolveFilebaseConfig(input.env)
    const session = await createSongArtifactUploadSession({
      client,
      session: {
        songArtifactUploadSessionId: makeId("saus"),
        communityId: input.communityId,
        songArtifactUploadId,
        uploaderUserId: input.userId,
        status: "parts_uploading",
        uploadMode: "direct_multipart",
        objectKey,
        filebaseUploadId,
        partSizeBytes: partPlan.partSizeBytes,
        totalParts: partPlan.totalParts,
        declaredSizeBytes: input.body.size_bytes ?? 0,
        declaredMimeType: mimeType,
        declaredContentHash: contentHash,
        bucket: config.bucket,
        storageEndpoint: config.endpoint.toString(),
        expiresAt: addMilliseconds(now, DIRECT_MULTIPART_SESSION_TTL_MS),
        createdAt: now,
        updatedAt: now,
      },
    })
    return {
      ...upload,
      upload_session: sessionDescriptor({
        origin: input.origin,
        communityId: input.communityId,
        songArtifactUploadId,
        session,
      }),
    }
  } catch (error) {
    await markSongArtifactUploadCancelled({
      client,
      communityId: input.communityId,
      songArtifactUploadId,
      updatedAt: nowIso(),
    }).catch(() => undefined)
    if (filebaseUploadId) {
      await abortMultipartUpload({
        env: input.env,
        objectKey,
        uploadId: filebaseUploadId,
      })
    }
    throw error
  }
}

export async function mintSongArtifactPartSignedUrl(input: {
  env: Env
  userId: string
  communityId: string
  songArtifactUploadId: string
  sessionId: string
  partNumber: number
  communityRepository: SongArtifactCommunityRepository
}): Promise<{ url: string; expires_at: string; part_number: number; part_size_bytes: number }> {
  const session = await requireOwnedSession(input)
  const client = getControlPlaneClient(input.env)
  if (session.status !== "parts_uploading") {
    throw badRequestError("Song artifact upload session is not accepting parts")
  }
  if (new Date(session.expires_at).getTime() <= Date.now()) {
    const now = nowIso()
    await markSongArtifactUploadSessionAborted({
      client,
      communityId: input.communityId,
      sessionId: input.sessionId,
      reason: "expired",
      abortedAt: now,
      updatedAt: now,
    })
    await markSongArtifactUploadCancelled({
      client,
      communityId: input.communityId,
      songArtifactUploadId: session.song_artifact_upload_id,
      updatedAt: now,
    })
    throw new HttpError(410, "upload_session_expired", "Upload session expired")
  }
  if (!session.filebase_upload_id || session.part_size_bytes == null || session.total_parts == null) {
    throw badRequestError("Song artifact upload session is missing multipart details")
  }
  if (!Number.isSafeInteger(input.partNumber) || input.partNumber < 1 || input.partNumber > session.total_parts) {
    throw badRequestError("Invalid multipart part number")
  }
  const mintedAt = nowIso()
  const extendedSession = await transitionSongArtifactUploadSession({
    client,
    communityId: input.communityId,
    sessionId: input.sessionId,
    fromStatus: "parts_uploading",
    toStatus: "parts_uploading",
    updatedAt: mintedAt,
    fields: {
      expires_at: addMilliseconds(mintedAt, DIRECT_MULTIPART_SESSION_TTL_MS),
    },
  })
  if (!extendedSession) {
    throw conflictError("Song artifact upload session is not accepting parts")
  }
  const url = await buildUploadPartPresignedUrl({
    env: input.env,
    objectKey: session.object_key,
    uploadId: session.filebase_upload_id,
    partNumber: input.partNumber,
    contentType: session.declared_mime_type,
    expiresInSeconds: DIRECT_MULTIPART_PART_URL_TTL_SECONDS,
  })
  return {
    url: url.toString(),
    expires_at: addMilliseconds(mintedAt, DIRECT_MULTIPART_PART_URL_TTL_SECONDS * 1000),
    part_number: input.partNumber,
    part_size_bytes: session.part_size_bytes,
  }
}

export async function completeMultipartSongArtifactUpload(input: {
  env: Env
  userId: string
  communityId: string
  songArtifactUploadId: string
  sessionId: string
  uploadId: string
  parts: ReadonlyArray<CompletedMultipartPart>
  contentHash?: string | null
  communityRepository: SongArtifactCommunityRepository
}): Promise<SongArtifactUpload> {
  const session = await requireOwnedSession(input)
  const client = getControlPlaneClient(input.env)
  if (session.status !== "parts_uploading") {
    throw badRequestError("Song artifact upload session is not ready to complete")
  }
  if (!session.filebase_upload_id || session.filebase_upload_id !== input.uploadId) {
    throw badRequestError("Multipart upload_id does not match the upload session")
  }
  const upload = await requireSongArtifactUpload(client, input.communityId, input.songArtifactUploadId)
  validateCompletedParts({ session, parts: input.parts })
  const contentHash = normalizeContentHash(input.contentHash) ?? normalizeContentHash(session.declared_content_hash)
  if (!contentHash) {
    throw badRequestError("content_hash is required to complete a direct_multipart upload")
  }
  const declaredHash = normalizeContentHash(session.declared_content_hash)
  if (declaredHash && declaredHash !== contentHash) {
    throw badRequestError("content_hash does not match the upload session")
  }

  const now = nowIso()
  const completing = await transitionSongArtifactUploadSession({
    client,
    communityId: input.communityId,
    sessionId: input.sessionId,
    fromStatus: "parts_uploading",
    toStatus: "completing",
    updatedAt: now,
  })
  if (!completing) {
    throw conflictError("Song artifact upload session completion already started")
  }

  const completeResult = await completeMultipartUpload({
    env: input.env,
    objectKey: session.object_key,
    uploadId: session.filebase_upload_id,
    parts: input.parts,
  })
  const headVerifying = await transitionSongArtifactUploadSession({
    client,
    communityId: input.communityId,
    sessionId: input.sessionId,
    fromStatus: "completing",
    toStatus: "head_verifying",
    updatedAt: nowIso(),
  })
  if (!headVerifying) {
    throw conflictError("Song artifact upload session was not ready for head verification")
  }
  const head = await headObjectAfterComplete({
    env: input.env,
    objectKey: session.object_key,
  })
  if (head.contentLength !== session.declared_size_bytes) {
    throw badRequestError("Multipart object size does not match the upload session")
  }
  if (normalizeHeadContentType(head.contentType) !== session.declared_mime_type) {
    throw badRequestError("Multipart object content type does not match the upload session")
  }
  if (head.cid && head.cid !== completeResult.cid) {
    throw badRequestError("Multipart object CID does not match the completion response")
  }

  const config = resolveFilebaseConfig(input.env)
  const gatewayUrl = upload.storage_ref
  const uploadedSession = await markSongArtifactUploadSessionUploaded({
    client,
    communityId: input.communityId,
    sessionId: input.sessionId,
    storageProvider: FILEBASE_SONG_ARTIFACT_STORAGE_PROVIDER,
    storageObjectKey: session.object_key,
    storageBucket: config.bucket,
    gatewayUrl,
    ipfsCid: head.cid ?? completeResult.cid,
    contentHash,
    sizeBytes: head.contentLength,
    completedAt: nowIso(),
    updatedAt: nowIso(),
  })
  if (!uploadedSession) {
    throw conflictError("Song artifact upload session was not ready for upload finalization")
  }
  return await markSongArtifactUploadUploaded({
    client,
    communityId: input.communityId,
    songArtifactUploadId: input.songArtifactUploadId,
    mimeType: session.declared_mime_type,
    sizeBytes: head.contentLength,
    contentHash,
    storageProvider: FILEBASE_SONG_ARTIFACT_STORAGE_PROVIDER,
    storageBucket: config.bucket,
    storageObjectKey: session.object_key,
    storageEndpoint: config.endpoint.toString(),
    gatewayUrl,
    ipfsCid: head.cid ?? completeResult.cid,
    updatedAt: nowIso(),
  })
}

export async function abortMultipartSongArtifactUpload(input: {
  env: Env
  userId: string
  communityId: string
  songArtifactUploadId: string
  sessionId: string
  reason: string
  communityRepository: SongArtifactCommunityRepository
}): Promise<SongArtifactUploadSessionRow | null> {
  const session = await requireOwnedSession(input)
  const client = getControlPlaneClient(input.env)
  const now = nowIso()
  const aborting = await transitionSongArtifactUploadSession({
    client,
    communityId: input.communityId,
    sessionId: input.sessionId,
    fromStatus: ["created", "parts_uploading", "completing", "head_verifying"],
    toStatus: "aborting",
    updatedAt: now,
  })
  if (!aborting && session.status !== "aborting") {
    if (session.status === "aborted") {
      return session
    }
    if (session.status === "uploaded") {
      throw conflictError("Song artifact upload session is already uploaded")
    }
    throw conflictError("Song artifact upload session is already terminal")
  }
  if (session.filebase_upload_id) {
    await abortMultipartUpload({
      env: input.env,
      objectKey: session.object_key,
      uploadId: session.filebase_upload_id,
    })
  }
  const aborted = await markSongArtifactUploadSessionAborted({
    client,
    communityId: input.communityId,
    sessionId: input.sessionId,
    reason: input.reason,
    abortedAt: nowIso(),
    updatedAt: nowIso(),
  })
  await markSongArtifactUploadCancelled({
    client,
    communityId: input.communityId,
    songArtifactUploadId: session.song_artifact_upload_id,
    updatedAt: nowIso(),
  })
  return aborted
}

export async function reapStaleMultipartSongArtifactUploads(input: {
  env: Env
  communityId: string
  limit?: number
}): Promise<{ scanned: number; aborted: number }> {
  const client = getControlPlaneClient(input.env)
  const stale = await listStaleSongArtifactUploadSessions({
    client,
    communityId: input.communityId,
    now: nowIso(),
    limit: input.limit ?? 50,
  })
  let abortedCount = 0
  for (const session of stale) {
    const now = nowIso()
    const aborting = await transitionSongArtifactUploadSession({
      client,
      communityId: input.communityId,
      sessionId: session.song_artifact_upload_session_id,
      fromStatus: ["created", "parts_uploading", "completing", "head_verifying", "aborting"],
      toStatus: "aborting",
      updatedAt: now,
    })
    if (!aborting && session.status !== "aborting") {
      continue
    }
    if (session.filebase_upload_id) {
      await abortMultipartUpload({
        env: input.env,
        objectKey: session.object_key,
        uploadId: session.filebase_upload_id,
      })
    }
    const aborted = await markSongArtifactUploadSessionAborted({
      client,
      communityId: input.communityId,
      sessionId: session.song_artifact_upload_session_id,
      reason: "expired",
      abortedAt: nowIso(),
      updatedAt: nowIso(),
    })
    if (aborted) {
      abortedCount += 1
      await markSongArtifactUploadCancelled({
        client,
        communityId: input.communityId,
        songArtifactUploadId: session.song_artifact_upload_id,
        updatedAt: nowIso(),
      })
    }
  }
  return { scanned: stale.length, aborted: abortedCount }
}
