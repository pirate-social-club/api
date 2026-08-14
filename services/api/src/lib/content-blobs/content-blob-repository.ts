import { executeFirst, type DbExecutor } from "../db-helpers"
import { conflictError, internalError, notFoundError } from "../errors"
import type { Client } from "../sql-client"
import { withTransaction } from "../transactions"
import {
  insertContentSecurityScanJob,
} from "../content-security/content-security-repository"
import type { ContentSecurityScannerRelease } from "../content-security/content-security-types"
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

export const CONTENT_BLOB_UPLOAD_INTENTS_PER_HOUR = 10
export const CONTENT_BLOB_COMPLETED_BYTES_PER_DAY = 250 * 1024 * 1024
export const CONTENT_BLOB_UNCLAIMED_LIMIT = 20
const CONTENT_BLOB_UNCLAIMED_TTL_MS = 24 * 60 * 60 * 1000

function quotaCutoff(createdAt: string, ttlMs: number): string {
  const timestamp = Date.parse(createdAt)
  return new Date((Number.isFinite(timestamp) ? timestamp : Date.now()) - ttlMs).toISOString()
}

function numericRowValue(row: unknown, key: string): number {
  const value = (row as Record<string, unknown> | undefined)?.[key]
  const parsed = typeof value === "number" ? value : Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Checks the upload allocation limits in the same transaction as the intent
 * insert. The counts intentionally use explicit status/claim predicates so
 * failed or expired orphan rows do not consume a user's active quota.
 */
async function assertContentBlobQuotaAvailable(
  tx: DbExecutor,
  input: CreateContentBlobIntentInput,
): Promise<void> {
  const hourlyCutoff = quotaCutoff(input.createdAt, 60 * 60 * 1000)
  const dailyCutoff = quotaCutoff(input.createdAt, CONTENT_BLOB_UNCLAIMED_TTL_MS)
  const result = await tx.execute({
    sql: `
      SELECT
        (SELECT COUNT(*) FROM content_blobs
          WHERE uploader_user_id = ?1 AND created_at >= ?2) AS intent_count,
        (SELECT COALESCE(SUM(verified_size_bytes), 0) FROM content_blobs
          WHERE uploader_user_id = ?1
            AND status IN ('uploaded', 'verifying', 'ready')
            AND verified_size_bytes IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM content_upload_sessions sessions
              WHERE sessions.content_blob_id = content_blobs.content_blob_id
                AND sessions.uploader_user_id = content_blobs.uploader_user_id
                AND sessions.completed_at >= ?3
            )) AS completed_bytes,
        (SELECT COUNT(*) FROM content_blobs
          WHERE uploader_user_id = ?1
            AND claim_kind IS NULL
            AND status NOT IN ('rejected', 'failed', 'cancelled')
            AND created_at >= ?3) AS unclaimed_count
    `,
    args: [input.uploaderUserId, hourlyCutoff, dailyCutoff],
  })
  const row = result.rows[0]
  const intentCount = numericRowValue(row, "intent_count")
  const completedBytes = numericRowValue(row, "completed_bytes")
  const unclaimedCount = numericRowValue(row, "unclaimed_count")
  if (intentCount >= CONTENT_BLOB_UPLOAD_INTENTS_PER_HOUR) {
    throw conflictError("Content upload intent limit reached; try again later")
  }
  const plannedBytes = input.declaredSizeBytes ?? 50 * 1024 * 1024
  if (completedBytes + plannedBytes > CONTENT_BLOB_COMPLETED_BYTES_PER_DAY) {
    throw conflictError("Completed upload byte limit reached; try again later")
  }
  if (unclaimedCount >= CONTENT_BLOB_UNCLAIMED_LIMIT) {
    throw conflictError("Unclaimed content blob limit reached; publish or remove an upload first")
  }
}

async function assertCompletedUploadQuotaAvailable(
  tx: DbExecutor,
  input: Pick<CreateContentBlobIntentInput, "uploaderUserId" | "createdAt"> & {
    contentBlobId: string
    verifiedSizeBytes: number
  },
): Promise<void> {
  const cutoff = quotaCutoff(input.createdAt, CONTENT_BLOB_UNCLAIMED_TTL_MS)
  const result = await tx.execute({
    sql: `
      SELECT COALESCE(SUM(verified_size_bytes), 0) AS completed_bytes
      FROM content_blobs
      WHERE uploader_user_id = ?1
        AND content_blob_id <> ?2
        AND status IN ('uploaded', 'verifying', 'ready')
        AND verified_size_bytes IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM content_upload_sessions sessions
          WHERE sessions.content_blob_id = content_blobs.content_blob_id
            AND sessions.uploader_user_id = content_blobs.uploader_user_id
            AND sessions.completed_at >= ?3
        )
    `,
    args: [input.uploaderUserId, input.contentBlobId, cutoff],
  })
  const completedBytes = numericRowValue(result.rows[0], "completed_bytes")
  if (completedBytes + input.verifiedSizeBytes > CONTENT_BLOB_COMPLETED_BYTES_PER_DAY) {
    throw conflictError("Completed upload byte limit reached; try again later")
  }
}

/**
 * Reconciles upload-intent orphans opportunistically. The control-plane object
 * remover can consume the returned IDs asynchronously; marking the ledger
 * cancelled first prevents stale rows from consuming intent and unclaimed
 * quotas forever.
 */
export async function expireUnclaimedContentBlobs(input: {
  client: Client
  now: string
  limit?: number
}): Promise<{ contentBlobIds: string[] }> {
  const cutoff = quotaCutoff(input.now, CONTENT_BLOB_UNCLAIMED_TTL_MS)
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 50)))
  const result = await input.client.execute({
    sql: `
      SELECT content_blob_id
      FROM content_blobs
      WHERE claim_kind IS NULL
        AND status IN ('pending_upload', 'uploaded', 'verifying')
        AND created_at < ?1
        AND NOT EXISTS (
          SELECT 1 FROM content_upload_sessions sessions
          WHERE sessions.content_blob_id = content_blobs.content_blob_id
            AND sessions.status IN ('created', 'parts_uploading', 'completing', 'head_verifying')
        )
      ORDER BY created_at ASC, content_blob_id ASC
      LIMIT ?2
    `,
    args: [cutoff, limit],
  })
  const contentBlobIds = result.rows
    .map((row) => (typeof row.content_blob_id === "string" ? row.content_blob_id : null))
    .filter((value): value is string => Boolean(value))
  if (contentBlobIds.length === 0) return { contentBlobIds }

  await withTransaction(input.client, "write", async (tx) => {
    for (const contentBlobId of contentBlobIds) {
      await tx.execute({
        sql: `
          UPDATE content_upload_sessions
          SET status = 'aborted', aborted_at = ?1,
              aborted_reason = 'content_blob_expired', updated_at = ?1
          WHERE content_blob_id = ?2
            AND status NOT IN ('uploaded', 'aborted')
        `,
        args: [input.now, contentBlobId],
      })
      await tx.execute({
        sql: `
          UPDATE content_blobs
          SET status = 'cancelled', rejection_code = 'content_blob_expired', updated_at = ?1
          WHERE content_blob_id = ?2
            AND claim_kind IS NULL
            AND status IN ('pending_upload', 'uploaded', 'verifying')
        `,
        args: [input.now, contentBlobId],
      })
    }
  })
  return { contentBlobIds }
}

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

/**
 * Claim a verified blob for one downstream owner.
 *
 * The claim is deliberately a single conditional UPDATE: publication can be
 * retried after a worker timeout, but a blob must never be attached to two
 * assets. Replaying the same claim is idempotent; every other competing claim
 * fails closed. Readiness and malware-clean state are checked in the UPDATE so
 * a scanner transition racing publication cannot be bypassed by a stale read.
 */
export async function claimOwnedReadyContentBlob(input: {
  client: Client
  communityId: string
  uploaderUserId: string
  contentBlobId: string
  claimKind: NonNullable<ContentBlobRow["claim_kind"]>
  claimRef: string
  claimedAt: string
}): Promise<OwnedContentBlob> {
  const owned = await requireOwnedContentBlob(input)
  const isReadyForClaim = owned.blob.status === "ready"
    && owned.blob.security_scan_state === "clean"
    && owned.blob.verified_size_bytes != null
    && owned.blob.verified_content_hash != null
  const existingClaim = owned.blob.claim_kind
    ? { kind: owned.blob.claim_kind, ref: owned.blob.claim_ref }
    : null
  if (existingClaim) {
    if (existingClaim.kind === input.claimKind && existingClaim.ref === input.claimRef) {
      if (!isReadyForClaim) {
        throw conflictError("Content blob is no longer ready to claim")
      }
      return owned
    }
    throw conflictError("Content blob is already claimed")
  }

  const result = await input.client.execute({
    sql: `
      UPDATE content_blobs
      SET claim_kind = ?1,
          claim_ref = ?2,
          claimed_at = ?3,
          updated_at = ?3
      WHERE content_blob_id = ?4
        AND community_id = ?5
        AND uploader_user_id = ?6
        AND status = 'ready'
        AND security_scan_state = 'clean'
        AND verified_size_bytes IS NOT NULL
        AND verified_content_hash IS NOT NULL
        AND claim_kind IS NULL
        AND claim_ref IS NULL
    `,
    args: [
      input.claimKind,
      input.claimRef,
      input.claimedAt,
      input.contentBlobId,
      input.communityId,
      input.uploaderUserId,
    ],
  })
  if ((result.rowsAffected ?? 0) !== 1) {
    const after = await findOwnedContentBlob(input)
    if (after?.blob.claim_kind === input.claimKind && after.blob.claim_ref === input.claimRef) {
      return after
    }
    if (!after) {
      throw notFoundError("Content blob not found")
    }
    throw conflictError("Content blob is not ready to claim")
  }

  const claimed = await findOwnedContentBlob(input)
  if (!claimed) {
    throw internalError("Content blob is missing after claim")
  }
  return claimed
}

/**
 * Compensate a failed generic publication attempt. The exact claim reference
 * is required so a retry cannot release a claim that has since been adopted by
 * another asset. Releasing an already-cleared claim is idempotent.
 */
export async function releaseOwnedContentBlobClaim(input: {
  client: Client
  communityId: string
  uploaderUserId: string
  contentBlobId: string
  claimKind: NonNullable<ContentBlobRow["claim_kind"]>
  claimRef: string
  releasedAt: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      UPDATE content_blobs
      SET claim_kind = NULL,
          claim_ref = NULL,
          claimed_at = NULL,
          updated_at = ?1
      WHERE content_blob_id = ?2
        AND community_id = ?3
        AND uploader_user_id = ?4
        AND claim_kind = ?5
        AND claim_ref = ?6
    `,
    args: [
      input.releasedAt,
      input.contentBlobId,
      input.communityId,
      input.uploaderUserId,
      input.claimKind,
      input.claimRef,
    ],
  })
}

export async function createContentBlobIntent(input: {
  client: Client
  intent: CreateContentBlobIntentInput
}): Promise<OwnedContentBlob> {
  // The scheduled sweeper performs the same operation in bulk; this cheap
  // bounded pass keeps a quiet community from accumulating quota ghosts.
  await expireUnclaimedContentBlobs({ client: input.client, now: input.intent.createdAt, limit: 10 })
  await withTransaction(input.client, "write", async (tx) => {
    const intent = input.intent
    await assertContentBlobQuotaAvailable(tx, intent)
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
  scanJob?: {
    scanJobId: string
    scannerRelease: ContentSecurityScannerRelease
    maxAttempts: number
  }
}): Promise<OwnedContentBlob> {
  await withTransaction(input.client, "write", async (tx) => {
    await assertCompletedUploadQuotaAvailable(tx, {
      uploaderUserId: input.uploaderUserId,
      contentBlobId: input.contentBlobId,
      verifiedSizeBytes: input.verifiedSizeBytes,
      createdAt: input.completedAt,
    })
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
    if (input.scanJob) {
      await insertContentSecurityScanJob({
        executor: tx,
        scanJobId: input.scanJob.scanJobId,
        contentBlobId: input.contentBlobId,
        scannerRelease: input.scanJob.scannerRelease,
        requestReason: "initial_upload",
        expectedContentHash: input.verifiedContentHash,
        expectedSizeBytes: input.verifiedSizeBytes,
        maxAttempts: input.scanJob.maxAttempts,
        now: input.completedAt,
      })
    }
  })

  return await requireOwnedContentBlob({
    client: input.client,
    communityId: input.communityId,
    uploaderUserId: input.uploaderUserId,
    contentBlobId: input.contentBlobId,
  })
}
