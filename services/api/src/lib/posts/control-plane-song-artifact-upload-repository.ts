import { requireControlPlaneDbUrl } from "../auth/control-plane-auth-queries"
import { createControlPlaneDbClient, type ControlPlaneDbClient } from "../control-plane-db"
import { internalError } from "../errors"
import { makeId } from "../helpers"
import type { CreateSongArtifactUploadRequest, Env, SongArtifactUpload } from "../../types"

type SongArtifactUploadRow = {
  song_artifact_upload_id: string
  community_id: string
  uploader_user_id: string
  artifact_kind: SongArtifactUpload["artifact_kind"]
  status: SongArtifactUpload["status"]
  storage_ref: string
  mime_type: string
  filename: string | null
  size_bytes: number | null
  content_hash: string | null
  storage_provider: SongArtifactUpload["storage_provider"] | null
  storage_bucket: string | null
  storage_object_key: string | null
  storage_endpoint: string | null
  gateway_url: string | null
  blob_path: string | null
  created_at: string
  updated_at: string
}

function toRow(row: unknown): SongArtifactUploadRow {
  if (!row || typeof row !== "object") {
    throw internalError("Song artifact upload row is invalid")
  }
  const value = row as Record<string, unknown>
  return {
    song_artifact_upload_id: String(value.song_artifact_upload_id || ""),
    community_id: String(value.community_id || ""),
    uploader_user_id: String(value.uploader_user_id || ""),
    artifact_kind: String(value.artifact_kind || "") as SongArtifactUpload["artifact_kind"],
    status: String(value.status || "") as SongArtifactUpload["status"],
    storage_ref: String(value.storage_ref || ""),
    mime_type: String(value.mime_type || ""),
    filename: value.filename == null ? null : String(value.filename),
    size_bytes: value.size_bytes == null ? null : Number(value.size_bytes),
    content_hash: value.content_hash == null ? null : String(value.content_hash),
    storage_provider: value.storage_provider == null ? null : String(value.storage_provider) as SongArtifactUpload["storage_provider"],
    storage_bucket: value.storage_bucket == null ? null : String(value.storage_bucket),
    storage_object_key: value.storage_object_key == null ? null : String(value.storage_object_key),
    storage_endpoint: value.storage_endpoint == null ? null : String(value.storage_endpoint),
    gateway_url: value.gateway_url == null ? null : String(value.gateway_url),
    blob_path: value.blob_path == null ? null : String(value.blob_path),
    created_at: String(value.created_at || ""),
    updated_at: String(value.updated_at || ""),
  }
}

function serializeUpload(row: SongArtifactUploadRow): SongArtifactUpload {
  return {
    song_artifact_upload_id: row.song_artifact_upload_id,
    community_id: row.community_id,
    uploader_user_id: row.uploader_user_id,
    artifact_kind: row.artifact_kind,
    status: row.status,
    storage_ref: row.storage_ref,
    mime_type: row.mime_type,
    filename: row.filename,
    size_bytes: row.size_bytes,
    content_hash: row.content_hash,
    storage_provider: row.storage_provider,
    storage_bucket: row.storage_bucket,
    storage_object_key: row.storage_object_key,
    storage_endpoint: row.storage_endpoint,
    gateway_url: row.gateway_url,
    upload_url: `/communities/${row.community_id}/song-artifact-uploads/${row.song_artifact_upload_id}/content`,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

export interface SongArtifactUploadRepository {
  createSongArtifactUpload(input: {
    communityId: string
    uploaderUserId: string
    body: CreateSongArtifactUploadRequest
    createdAt: string
  }): Promise<SongArtifactUpload>
  getSongArtifactUploadById(uploadId: string): Promise<SongArtifactUpload | null>
  getSongArtifactUploadByStorageRef(storageRef: string): Promise<SongArtifactUpload | null>
  completeSongArtifactUpload(input: {
    uploadId: string
    status: SongArtifactUpload["status"]
    storageRef: string | null
    storageProvider: SongArtifactUpload["storage_provider"] | null
    storageBucket: string | null
    storageObjectKey: string | null
    storageEndpoint: string | null
    gatewayUrl: string | null
    sizeBytes: number | null
    contentHash: string | null
    blobPath: string | null
    updatedAt: string
  }): Promise<SongArtifactUpload | null>
}

class ControlPlaneSongArtifactUploadRepository implements SongArtifactUploadRepository {
  constructor(private readonly client: ControlPlaneDbClient) {}

  async createSongArtifactUpload(input: {
    communityId: string
    uploaderUserId: string
    body: CreateSongArtifactUploadRequest
    createdAt: string
  }): Promise<SongArtifactUpload> {
    const uploadId = makeId("sau")
    const storageRef = `ipfs://local-song-artifact-upload/${uploadId}`
    await this.client.execute({
      sql: `
        INSERT INTO song_artifact_uploads (
          song_artifact_upload_id, community_id, uploader_user_id, artifact_kind, status, storage_ref,
          mime_type, filename, size_bytes, content_hash, storage_provider, storage_bucket, storage_object_key,
          storage_endpoint, gateway_url, blob_path, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, 'pending_upload', ?5,
          ?6, ?7, ?8, ?9, NULL, NULL, NULL,
          NULL, NULL, NULL, ?10, ?10
        )
      `,
      args: [
        uploadId,
        input.communityId,
        input.uploaderUserId,
        input.body.artifact_kind,
        storageRef,
        input.body.mime_type,
        input.body.filename ?? null,
        input.body.size_bytes ?? null,
        input.body.content_hash ?? null,
        input.createdAt,
      ],
    })

    const created = await this.getSongArtifactUploadById(uploadId)
    if (!created) {
      throw internalError("Song artifact upload row is missing after insert")
    }
    return created
  }

  async getSongArtifactUploadById(uploadId: string): Promise<SongArtifactUpload | null> {
    const result = await this.client.execute({
      sql: `
        SELECT song_artifact_upload_id, community_id, uploader_user_id, artifact_kind, status, storage_ref,
               mime_type, filename, size_bytes, content_hash, storage_provider, storage_bucket, storage_object_key,
               storage_endpoint, gateway_url, blob_path, created_at, updated_at
        FROM song_artifact_uploads
        WHERE song_artifact_upload_id = ?1
        LIMIT 1
      `,
      args: [uploadId],
    })
    const row = result.rows[0]
    return row ? serializeUpload(toRow(row)) : null
  }

  async getSongArtifactUploadByStorageRef(storageRef: string): Promise<SongArtifactUpload | null> {
    const result = await this.client.execute({
      sql: `
        SELECT song_artifact_upload_id, community_id, uploader_user_id, artifact_kind, status, storage_ref,
               mime_type, filename, size_bytes, content_hash, storage_provider, storage_bucket, storage_object_key,
               storage_endpoint, gateway_url, blob_path, created_at, updated_at
        FROM song_artifact_uploads
        WHERE storage_ref = ?1
        LIMIT 1
      `,
      args: [storageRef],
    })
    const row = result.rows[0]
    return row ? serializeUpload(toRow(row)) : null
  }

  async completeSongArtifactUpload(input: {
    uploadId: string
    status: SongArtifactUpload["status"]
    storageRef: string | null
    storageProvider: SongArtifactUpload["storage_provider"] | null
    storageBucket: string | null
    storageObjectKey: string | null
    storageEndpoint: string | null
    gatewayUrl: string | null
    sizeBytes: number | null
    contentHash: string | null
    blobPath: string | null
    updatedAt: string
  }): Promise<SongArtifactUpload | null> {
    const result = await this.client.execute({
      sql: `
        UPDATE song_artifact_uploads
        SET status = ?2,
            storage_ref = COALESCE(?3, storage_ref),
            storage_provider = ?4,
            storage_bucket = ?5,
            storage_object_key = ?6,
            storage_endpoint = ?7,
            gateway_url = ?8,
            size_bytes = ?9,
            content_hash = ?10,
            blob_path = ?11,
            updated_at = ?12
        WHERE song_artifact_upload_id = ?1
          AND status = 'pending_upload'
      `,
      args: [
        input.uploadId,
        input.status,
        input.storageRef,
        input.storageProvider ?? null,
        input.storageBucket,
        input.storageObjectKey,
        input.storageEndpoint,
        input.gatewayUrl,
        input.sizeBytes,
        input.contentHash,
        input.blobPath,
        input.updatedAt,
      ],
    })
    if (result.rowsAffected === 0) {
      return null
    }
    return this.getSongArtifactUploadById(input.uploadId)
  }
}

const globalScope = globalThis as typeof globalThis & {
  __pirateSongArtifactUploadRepository?: SongArtifactUploadRepository
  __pirateSongArtifactUploadRepositoryKey?: string
}

export function getControlPlaneSongArtifactUploadRepository(env: Env): SongArtifactUploadRepository {
  const cacheKey = requireControlPlaneDbUrl(env)

  if (
    globalScope.__pirateSongArtifactUploadRepository
    && globalScope.__pirateSongArtifactUploadRepositoryKey === cacheKey
  ) {
    return globalScope.__pirateSongArtifactUploadRepository
  }

  const repository = new ControlPlaneSongArtifactUploadRepository(createControlPlaneDbClient(env))
  globalScope.__pirateSongArtifactUploadRepository = repository
  globalScope.__pirateSongArtifactUploadRepositoryKey = cacheKey
  return repository
}
