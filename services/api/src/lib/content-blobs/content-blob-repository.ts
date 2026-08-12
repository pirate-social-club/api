import { executeFirst, type DbExecutor } from "../db-helpers"
import { conflictError, internalError, notFoundError } from "../errors"
import type { Client } from "../sql-client"
import { withTransaction } from "../transactions"
import {
  CONTENT_BLOB_COLUMNS,
  CONTENT_UPLOAD_SESSION_COLUMNS,
  toContentBlobRow,
  toContentUploadSessionRow,
} from "./content-blob-row-mappers"
import type {
  ContentBlobRow,
  ContentUploadSessionRow,
  CreateContentBlobIntentInput,
  OwnedContentBlob,
} from "./content-blob-types"

async function findBlob(input: {
  executor: DbExecutor
  communityId: string
  uploaderUserId: string
  contentBlobId: string
}): Promise<ContentBlobRow | null> {
  const row = await executeFirst(input.executor, {
    sql: `
      SELECT ${CONTENT_BLOB_COLUMNS}
      FROM content_blobs
      WHERE community_id = ?1
        AND uploader_user_id = ?2
        AND content_blob_id = ?3
      LIMIT 1
    `,
    args: [input.communityId, input.uploaderUserId, input.contentBlobId],
  })
  return row ? toContentBlobRow(row) : null
}

async function findLatestSession(input: {
  executor: DbExecutor
  uploaderUserId: string
  contentBlobId: string
}): Promise<ContentUploadSessionRow | null> {
  const row = await executeFirst(input.executor, {
    sql: `
      SELECT ${CONTENT_UPLOAD_SESSION_COLUMNS}
      FROM content_upload_sessions
      WHERE content_blob_id = ?1
        AND uploader_user_id = ?2
      ORDER BY created_at DESC, content_upload_session_id DESC
      LIMIT 1
    `,
    args: [input.contentBlobId, input.uploaderUserId],
  })
  return row ? toContentUploadSessionRow(row) : null
}

export async function findOwnedContentBlob(input: {
  client: Client
  communityId: string
  uploaderUserId: string
  contentBlobId: string
}): Promise<OwnedContentBlob | null> {
  const blob = await findBlob({ executor: input.client, ...input })
  if (!blob) return null
  const uploadSession = await findLatestSession({ executor: input.client, ...input })
  return { blob, uploadSession }
}

export async function requireOwnedContentBlob(input: {
  client: Client
  communityId: string
  uploaderUserId: string
  contentBlobId: string
}): Promise<OwnedContentBlob> {
  const owned = await findOwnedContentBlob(input)
  if (!owned) {
    throw notFoundError("Content blob not found")
  }
  return owned
}

export async function createContentBlobIntent(input: {
  client: Client
  intent: CreateContentBlobIntentInput
}): Promise<OwnedContentBlob> {
  await withTransaction(input.client, "write", async (tx) => {
    const intent = input.intent
    await tx.execute({
      sql: `
        INSERT INTO content_blobs (
          content_blob_id, community_id, uploader_user_id, status, validation_profile,
          declared_filename, declared_mime_type, declared_size_bytes, declared_content_hash,
          security_scan_state, plaintext_retention_state, storage_ref, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, 'pending_upload', ?4, ?5, ?6, ?7, ?8,
          'pending', 'active', ?9, ?10, ?10
        )
      `,
      args: [
        intent.contentBlobId,
        intent.communityId,
        intent.uploaderUserId,
        intent.validationProfile,
        intent.declaredFilename,
        intent.declaredMimeType,
        intent.declaredSizeBytes,
        intent.declaredContentHash,
        intent.storageRef,
        intent.createdAt,
      ],
    })
    await tx.execute({
      sql: `
        INSERT INTO content_upload_sessions (
          content_upload_session_id, content_blob_id, uploader_user_id, status, upload_mode,
          object_key, provider_upload_id, part_size_bytes, total_parts, bucket,
          storage_endpoint, expires_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13
        )
      `,
      args: [
        intent.contentUploadSessionId,
        intent.contentBlobId,
        intent.uploaderUserId,
        intent.uploadMode === "proxy" ? "created" : "parts_uploading",
        intent.uploadMode,
        intent.objectKey,
        intent.providerUploadId,
        intent.partSizeBytes,
        intent.totalParts,
        intent.bucket,
        intent.storageEndpoint,
        intent.expiresAt,
        intent.createdAt,
      ],
    })
  })

  const created = await findOwnedContentBlob({
    client: input.client,
    communityId: input.intent.communityId,
    uploaderUserId: input.intent.uploaderUserId,
    contentBlobId: input.intent.contentBlobId,
  })
  if (!created) {
    throw internalError("Content blob is missing after insert")
  }
  return created
}

export async function beginProxyContentUpload(input: {
  client: Client
  communityId: string
  uploaderUserId: string
  contentBlobId: string
  contentUploadSessionId: string
  updatedAt: string
}): Promise<boolean> {
  const result = await input.client.execute({
    sql: `
      UPDATE content_upload_sessions AS sessions
      SET status = 'parts_uploading', updated_at = ?1
      WHERE sessions.content_upload_session_id = ?2
        AND sessions.content_blob_id = ?3
        AND sessions.uploader_user_id = ?4
        AND sessions.upload_mode = 'proxy'
        AND sessions.status = 'created'
        AND EXISTS (
          SELECT 1
          FROM content_blobs AS blobs
          WHERE blobs.content_blob_id = sessions.content_blob_id
            AND blobs.community_id = ?5
            AND blobs.uploader_user_id = ?4
            AND blobs.status = 'pending_upload'
        )
    `,
    args: [
      input.updatedAt,
      input.contentUploadSessionId,
      input.contentBlobId,
      input.uploaderUserId,
      input.communityId,
    ],
  })
  return (result.rowsAffected ?? 0) === 1
}

export async function releaseProxyContentUpload(input: {
  client: Client
  uploaderUserId: string
  contentBlobId: string
  contentUploadSessionId: string
  updatedAt: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE content_upload_sessions
      SET status = 'created', updated_at = ?1
      WHERE content_upload_session_id = ?2
        AND content_blob_id = ?3
        AND uploader_user_id = ?4
        AND upload_mode = 'proxy'
        AND status = 'parts_uploading'
    `,
    args: [
      input.updatedAt,
      input.contentUploadSessionId,
      input.contentBlobId,
      input.uploaderUserId,
    ],
  })
}

export async function markProxyContentBlobUploaded(input: {
  client: Client
  communityId: string
  uploaderUserId: string
  contentBlobId: string
  contentUploadSessionId: string
  verifiedSizeBytes: number
  verifiedContentHash: string
  storageProvider: string
  storageBucket: string
  storageObjectKey: string
  storageEndpoint: string
  gatewayUrl: string | null
  ipfsCid: string | null
  completedAt: string
}): Promise<OwnedContentBlob> {
  await withTransaction(input.client, "write", async (tx) => {
    const sessionResult = await tx.execute({
      sql: `
        UPDATE content_upload_sessions
        SET status = 'uploaded', completed_at = ?1, updated_at = ?1
        WHERE content_upload_session_id = ?2
          AND content_blob_id = ?3
          AND uploader_user_id = ?4
          AND upload_mode = 'proxy'
          AND status = 'parts_uploading'
      `,
      args: [
        input.completedAt,
        input.contentUploadSessionId,
        input.contentBlobId,
        input.uploaderUserId,
      ],
    })
    if ((sessionResult.rowsAffected ?? 0) !== 1) {
      throw conflictError("Content upload session is not ready to complete")
    }

    const blobResult = await tx.execute({
      sql: `
        UPDATE content_blobs
        SET status = 'uploaded',
            verified_size_bytes = ?1,
            verified_content_hash = ?2,
            storage_provider = ?3,
            storage_bucket = ?4,
            storage_object_key = ?5,
            storage_endpoint = ?6,
            gateway_url = ?7,
            ipfs_cid = ?8,
            updated_at = ?9
        WHERE content_blob_id = ?10
          AND community_id = ?11
          AND uploader_user_id = ?12
          AND status = 'pending_upload'
      `,
      args: [
        input.verifiedSizeBytes,
        input.verifiedContentHash,
        input.storageProvider,
        input.storageBucket,
        input.storageObjectKey,
        input.storageEndpoint,
        input.gatewayUrl,
        input.ipfsCid,
        input.completedAt,
        input.contentBlobId,
        input.communityId,
        input.uploaderUserId,
      ],
    })
    if ((blobResult.rowsAffected ?? 0) !== 1) {
      throw conflictError("Content blob is not ready to complete")
    }
  })

  return await requireOwnedContentBlob({
    client: input.client,
    communityId: input.communityId,
    uploaderUserId: input.uploaderUserId,
    contentBlobId: input.contentBlobId,
  })
}
