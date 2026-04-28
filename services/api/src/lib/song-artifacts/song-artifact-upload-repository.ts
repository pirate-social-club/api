import { executeFirst } from "../db-helpers"
import { internalError, notFoundError } from "../errors"
import type { Client } from "../sql-client"
import type {
  CreateSongArtifactUploadRequest,
  SongArtifactUpload,
} from "../../types"
import {
  type SongArtifactUploadRow,
  serializeSongArtifactUpload,
  toSongArtifactUploadRow,
} from "./song-artifact-serialization"

async function getSongArtifactUploadRow(
  client: Client,
  communityId: string,
  songArtifactUploadId: string,
): Promise<SongArtifactUploadRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT song_artifact_upload_id, community_id, uploader_user_id, artifact_kind, status, storage_ref,
             mime_type, filename, size_bytes, content_hash, storage_provider, storage_bucket,
             storage_object_key, storage_endpoint, gateway_url, created_at, updated_at
      FROM song_artifact_uploads
      WHERE community_id = ?1
        AND song_artifact_upload_id = ?2
      LIMIT 1
    `,
    args: [communityId, songArtifactUploadId],
  })

  return row ? toSongArtifactUploadRow(row) : null
}

export async function createSongArtifactUploadIntent(input: {
  client: Client
  communityId: string
  userId: string
  songArtifactUploadId: string
  storageRef: string
  body: CreateSongArtifactUploadRequest
  createdAt: string
}): Promise<SongArtifactUpload> {
  await input.client.execute({
    sql: `
      INSERT INTO song_artifact_uploads (
        song_artifact_upload_id, community_id, uploader_user_id, artifact_kind, status, storage_ref,
        mime_type, filename, size_bytes, content_hash, storage_provider, storage_bucket,
        storage_object_key, storage_endpoint, gateway_url, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, 'pending_upload', ?5,
        ?6, ?7, ?8, ?9, NULL, NULL,
        NULL, NULL, NULL, ?10, ?10
      )
    `,
    args: [
      input.songArtifactUploadId,
      input.communityId,
      input.userId,
      input.body.artifact_kind,
      input.storageRef,
      input.body.mime_type.trim().toLowerCase(),
      input.body.filename?.trim() || null,
      input.body.size_bytes ?? null,
      input.body.content_hash?.trim() || null,
      input.createdAt,
    ],
  })

  const created = await getSongArtifactUploadRow(input.client, input.communityId, input.songArtifactUploadId)
  if (!created) {
    throw internalError("Song artifact upload is missing after insert")
  }
  return serializeSongArtifactUpload(created)
}

export async function getSongArtifactUpload(
  client: Client,
  communityId: string,
  songArtifactUploadId: string,
): Promise<SongArtifactUpload | null> {
  const row = await getSongArtifactUploadRow(client, communityId, songArtifactUploadId)
  return row ? serializeSongArtifactUpload(row) : null
}

export async function requireSongArtifactUpload(
  client: Client,
  communityId: string,
  songArtifactUploadId: string,
): Promise<SongArtifactUpload> {
  const upload = await getSongArtifactUpload(client, communityId, songArtifactUploadId)
  if (!upload) {
    throw notFoundError("Song artifact upload not found")
  }
  return upload
}

export async function findUploadedSongArtifactByStorageRef(input: {
  client: Client
  communityId: string
  storageRef: string
  artifactKind?: SongArtifactUpload["artifact_kind"]
}): Promise<SongArtifactUpload | null> {
  const hasArtifactKind = typeof input.artifactKind === "string" && input.artifactKind.length > 0
  const row = await executeFirst(input.client, {
    sql: `
      SELECT song_artifact_upload_id, community_id, uploader_user_id, artifact_kind, status, storage_ref,
             mime_type, filename, size_bytes, content_hash, storage_provider, storage_bucket,
             storage_object_key, storage_endpoint, gateway_url, created_at, updated_at
      FROM song_artifact_uploads
      WHERE community_id = ?1
        AND status = 'uploaded'
        ${hasArtifactKind ? "AND artifact_kind = ?2" : ""}
        AND (${hasArtifactKind ? "storage_ref = ?3 OR gateway_url = ?3" : "storage_ref = ?2 OR gateway_url = ?2"})
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    args: hasArtifactKind
      ? [input.communityId, input.artifactKind, input.storageRef]
      : [input.communityId, input.storageRef],
  })

  return row ? serializeSongArtifactUpload(toSongArtifactUploadRow(row)) : null
}

export async function markSongArtifactUploadUploaded(input: {
  client: Client
  communityId: string
  songArtifactUploadId: string
  mimeType: string
  sizeBytes: number
  contentHash: string
  storageProvider: "filebase" | "local_stub"
  storageBucket: string
  storageObjectKey: string
  storageEndpoint: string
  gatewayUrl: string
  updatedAt: string
}): Promise<SongArtifactUpload> {
  await input.client.execute({
    sql: `
      UPDATE song_artifact_uploads
      SET status = 'uploaded',
          mime_type = ?3,
          size_bytes = ?4,
          content_hash = ?5,
          storage_provider = ?6,
          storage_bucket = ?7,
          storage_object_key = ?8,
          storage_endpoint = ?9,
          gateway_url = ?10,
          updated_at = ?11
      WHERE community_id = ?1
        AND song_artifact_upload_id = ?2
    `,
    args: [
      input.communityId,
      input.songArtifactUploadId,
      input.mimeType,
      input.sizeBytes,
      input.contentHash,
      input.storageProvider,
      input.storageBucket,
      input.storageObjectKey,
      input.storageEndpoint,
      input.gatewayUrl,
      input.updatedAt,
    ],
  })

  const updated = await getSongArtifactUploadRow(input.client, input.communityId, input.songArtifactUploadId)
  if (!updated) {
    throw internalError("Song artifact upload is missing after update")
  }
  return serializeSongArtifactUpload(updated)
}
