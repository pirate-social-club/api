import type { UserRepository } from "../auth/repositories"
import { openCommunityDb } from "../communities/community-db-factory"
import { badRequestError, notFoundError } from "../errors"
import { makeId, nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import { sha256Hex } from "../crypto"
import {
  createSongArtifactUploadIntent,
  markSongArtifactUploadUploaded,
  requireSongArtifactUpload,
} from "./song-artifact-repository"
import {
  assertSongArtifactMimeType,
  assertSongArtifactSize,
  buildSongArtifactContentUrl,
  fetchSongArtifactBytes,
  type SongArtifactKind,
  uploadSongArtifactBytes,
} from "./song-artifact-storage"
import {
  requireActiveCommunity,
  requireMemberAccess,
  requireVerifiedHuman,
} from "./song-artifact-access"
import type { Env } from "../../env"
import type { CreateSongArtifactUploadRequest, SongArtifactUpload } from "../../types"
import type { SongArtifactCommunityRepository } from "./song-artifact-types"

function assertUploadRequest(input: CreateSongArtifactUploadRequest): void {
  const kind = input.artifact_kind as SongArtifactKind
  if (kind === "preview_audio") {
    throw badRequestError("preview_audio upload intents are not supported; use preview_window")
  }
  const mimeType = input.mime_type.trim().toLowerCase()
  if (!mimeType) {
    throw badRequestError("mime_type is required")
  }
  assertSongArtifactMimeType(kind, mimeType)
  if (input.size_bytes != null) {
    assertSongArtifactSize(kind, input.size_bytes)
  }
}

function normalizeUploadBytes(bytes: ArrayBuffer | Uint8Array): Uint8Array {
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
}

function validateUploadMatch(upload: SongArtifactUpload, bytes: Uint8Array): void {
  assertSongArtifactMimeType(upload.artifact_kind as SongArtifactKind, upload.mime_type)
  assertSongArtifactSize(upload.artifact_kind as SongArtifactKind, bytes.byteLength)
  if (upload.size_bytes != null && upload.size_bytes !== bytes.byteLength) {
    throw badRequestError(`Uploaded byte count does not match the declared size for ${upload.id}`)
  }
}

export async function createSongArtifactUpload(input: {
  env: Env
  userId: string
  communityId: string
  body: CreateSongArtifactUploadRequest
  userRepository: UserRepository
  communityRepository: SongArtifactCommunityRepository
  origin: string
}): Promise<SongArtifactUpload> {
  assertUploadRequest(input.body)
  await requireActiveCommunity(input.communityRepository, input.communityId)

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireMemberAccess(db.client, input.communityId, input.userId)
    await requireVerifiedHuman(input.userRepository, input.userId)

    const client = getControlPlaneClient(input.env)
    const songArtifactUploadId = makeId("sau")
    return await createSongArtifactUploadIntent({
      client,
      communityId: input.communityId,
      userId: input.userId,
      songArtifactUploadId,
      storageRef: buildSongArtifactContentUrl(input.origin, input.communityId, songArtifactUploadId),
      body: input.body,
      createdAt: nowIso(),
    })
  } finally {
    db.close()
  }
}

export async function uploadSongArtifactContent(input: {
  env: Env
  userId: string
  communityId: string
  songArtifactUploadId: string
  content: ArrayBuffer | Uint8Array
  userRepository: UserRepository
  communityRepository: SongArtifactCommunityRepository
  origin: string
}): Promise<SongArtifactUpload> {
  await requireActiveCommunity(input.communityRepository, input.communityId)

  const db = await openCommunityDb(input.env, input.communityRepository, input.communityId)
  try {
    await requireMemberAccess(db.client, input.communityId, input.userId)
    await requireVerifiedHuman(input.userRepository, input.userId)

    const client = getControlPlaneClient(input.env)
    const upload = await requireSongArtifactUpload(client, input.communityId, input.songArtifactUploadId)
    if (upload.uploader_user !== `usr_${input.userId}`) {
      throw notFoundError("Song artifact upload not found")
    }
    if (upload.status === "uploaded") {
      return upload
    }
    if (upload.status !== "pending_upload") {
      throw badRequestError(`Song artifact upload ${upload.id} is not ready for content upload`)
    }

    const bytes = normalizeUploadBytes(input.content)
    validateUploadMatch(upload, bytes)
    const expectedHash = upload.content_hash?.trim() || null
    const actualHash = `0x${await sha256Hex(bytes)}`
    if (expectedHash && expectedHash !== actualHash) {
      throw badRequestError(`content_hash does not match uploaded bytes for ${upload.id}`)
    }

    const storage = await uploadSongArtifactBytes({
      env: input.env,
      communityId: input.communityId,
      songArtifactUploadId: input.songArtifactUploadId,
      artifactKind: upload.artifact_kind as SongArtifactKind,
      mimeType: upload.mime_type,
      bytes,
      origin: input.origin,
    })
    return await markSongArtifactUploadUploaded({
      client,
      communityId: input.communityId,
      songArtifactUploadId: input.songArtifactUploadId,
      mimeType: upload.mime_type,
      sizeBytes: bytes.byteLength,
      contentHash: storage.contentHash,
      storageProvider: storage.storageProvider,
      storageBucket: storage.storageBucket,
      storageObjectKey: storage.storageObjectKey,
      storageEndpoint: storage.storageEndpoint,
      gatewayUrl: storage.gatewayUrl,
      updatedAt: nowIso(),
    })
  } finally {
    db.close()
  }
}

export async function fetchSongArtifactContent(input: {
  env: Env
  communityId: string
  songArtifactUploadId: string
}): Promise<Response> {
  const client = getControlPlaneClient(input.env)
  const upload = await requireSongArtifactUpload(client, input.communityId, input.songArtifactUploadId)
  if (!upload.storage_object_key) {
    throw notFoundError("Song artifact content not found")
  }
  return await fetchSongArtifactBytes({
    env: input.env,
    objectKey: upload.storage_object_key,
  })
}
