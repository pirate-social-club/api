import { executeFirst } from "../db-helpers"
import { internalError, notFoundError } from "../errors"
import { requiredNumber, requiredString, rowValue, stringOrNull, numberOrNull } from "../sql-row"
import type { Client } from "../sql-client"
import type { SongArtifactStorageProvider } from "./song-artifact-storage-provider"

export type SongArtifactUploadSessionStatus =
  | "created"
  | "parts_uploading"
  | "completing"
  | "head_verifying"
  | "uploaded"
  | "aborting"
  | "aborted"

type SongArtifactUploadMode = "proxy" | "direct_multipart"

export type SongArtifactUploadSessionRow = {
  song_artifact_upload_session_id: string
  community_id: string
  song_artifact_upload_id: string
  uploader_user_id: string
  status: SongArtifactUploadSessionStatus
  upload_mode: SongArtifactUploadMode
  object_key: string
  filebase_upload_id: string | null
  part_size_bytes: number | null
  total_parts: number | null
  declared_size_bytes: number
  declared_mime_type: string
  declared_content_hash: string | null
  bucket: string
  storage_endpoint: string
  expires_at: string
  storage_provider: SongArtifactStorageProvider | null
  storage_object_key: string | null
  storage_bucket: string | null
  gateway_url: string | null
  ipfs_cid: string | null
  content_hash: string | null
  size_bytes: number | null
  created_at: string
  updated_at: string
  completed_at: string | null
  aborted_at: string | null
  aborted_reason: string | null
}

export type CreateSongArtifactUploadSessionInput = {
  songArtifactUploadSessionId: string
  communityId: string
  songArtifactUploadId: string
  uploaderUserId: string
  status: SongArtifactUploadSessionStatus
  uploadMode: SongArtifactUploadMode
  objectKey: string
  filebaseUploadId?: string | null
  partSizeBytes?: number | null
  totalParts?: number | null
  declaredSizeBytes: number
  declaredMimeType: string
  declaredContentHash?: string | null
  bucket: string
  storageEndpoint: string
  expiresAt: string
  storageProvider?: SongArtifactStorageProvider | null
  storageObjectKey?: string | null
  storageBucket?: string | null
  gatewayUrl?: string | null
  ipfsCid?: string | null
  contentHash?: string | null
  sizeBytes?: number | null
  createdAt: string
  updatedAt: string
}

type SessionTransitionFields = {
  filebase_upload_id?: string | null
  part_size_bytes?: number | null
  total_parts?: number | null
  expires_at?: string | null
  storage_provider?: SongArtifactStorageProvider | null
  storage_object_key?: string | null
  storage_bucket?: string | null
  gateway_url?: string | null
  ipfs_cid?: string | null
  content_hash?: string | null
  size_bytes?: number | null
  completed_at?: string | null
  aborted_at?: string | null
  aborted_reason?: string | null
}

const SESSION_COLUMNS = `
  song_artifact_upload_session_id, community_id, song_artifact_upload_id, uploader_user_id,
  status, upload_mode, object_key, filebase_upload_id, part_size_bytes, total_parts,
  declared_size_bytes, declared_mime_type, declared_content_hash, bucket, storage_endpoint,
  expires_at, storage_provider, storage_object_key, storage_bucket, gateway_url, ipfs_cid,
  content_hash, size_bytes, created_at, updated_at, completed_at, aborted_at, aborted_reason
`

const ACTIVE_SESSION_STATUSES: ReadonlyArray<SongArtifactUploadSessionStatus> = [
  "created",
  "parts_uploading",
  "completing",
  "head_verifying",
  "aborting",
]

function toSongArtifactUploadSessionRow(row: unknown): SongArtifactUploadSessionRow {
  return {
    song_artifact_upload_session_id: requiredString(row, "song_artifact_upload_session_id"),
    community_id: requiredString(row, "community_id"),
    song_artifact_upload_id: requiredString(row, "song_artifact_upload_id"),
    uploader_user_id: requiredString(row, "uploader_user_id"),
    status: requiredString(row, "status") as SongArtifactUploadSessionStatus,
    upload_mode: requiredString(row, "upload_mode") as SongArtifactUploadMode,
    object_key: requiredString(row, "object_key"),
    filebase_upload_id: stringOrNull(rowValue(row, "filebase_upload_id")),
    part_size_bytes: numberOrNull(rowValue(row, "part_size_bytes")),
    total_parts: numberOrNull(rowValue(row, "total_parts")),
    declared_size_bytes: requiredNumber(row, "declared_size_bytes"),
    declared_mime_type: requiredString(row, "declared_mime_type"),
    declared_content_hash: stringOrNull(rowValue(row, "declared_content_hash")),
    bucket: requiredString(row, "bucket"),
    storage_endpoint: requiredString(row, "storage_endpoint"),
    expires_at: requiredString(row, "expires_at"),
    storage_provider: stringOrNull(rowValue(row, "storage_provider")) as SongArtifactStorageProvider | null,
    storage_object_key: stringOrNull(rowValue(row, "storage_object_key")),
    storage_bucket: stringOrNull(rowValue(row, "storage_bucket")),
    gateway_url: stringOrNull(rowValue(row, "gateway_url")),
    ipfs_cid: stringOrNull(rowValue(row, "ipfs_cid")),
    content_hash: stringOrNull(rowValue(row, "content_hash")),
    size_bytes: numberOrNull(rowValue(row, "size_bytes")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
    completed_at: stringOrNull(rowValue(row, "completed_at")),
    aborted_at: stringOrNull(rowValue(row, "aborted_at")),
    aborted_reason: stringOrNull(rowValue(row, "aborted_reason")),
  }
}

async function getSessionRow(input: {
  client: Client
  communityId: string
  sessionId: string
}): Promise<SongArtifactUploadSessionRow | null> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT ${SESSION_COLUMNS}
      FROM song_artifact_upload_sessions
      WHERE community_id = ?1
        AND song_artifact_upload_session_id = ?2
      LIMIT 1
    `,
    args: [input.communityId, input.sessionId],
  })

  return row ? toSongArtifactUploadSessionRow(row) : null
}

export async function createSongArtifactUploadSession(input: {
  client: Client
  session: CreateSongArtifactUploadSessionInput
}): Promise<SongArtifactUploadSessionRow> {
  await input.client.execute({
    sql: `
      INSERT INTO song_artifact_upload_sessions (
        song_artifact_upload_session_id, community_id, song_artifact_upload_id, uploader_user_id,
        status, upload_mode, object_key, filebase_upload_id, part_size_bytes, total_parts,
        declared_size_bytes, declared_mime_type, declared_content_hash, bucket, storage_endpoint,
        expires_at, storage_provider, storage_object_key, storage_bucket, gateway_url, ipfs_cid,
        content_hash, size_bytes, created_at, updated_at, completed_at, aborted_at, aborted_reason
      ) VALUES (
        ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14,
        ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24, ?25, NULL, NULL, NULL
      )
    `,
    args: [
      input.session.songArtifactUploadSessionId,
      input.session.communityId,
      input.session.songArtifactUploadId,
      input.session.uploaderUserId,
      input.session.status,
      input.session.uploadMode,
      input.session.objectKey,
      input.session.filebaseUploadId ?? null,
      input.session.partSizeBytes ?? null,
      input.session.totalParts ?? null,
      input.session.declaredSizeBytes,
      input.session.declaredMimeType,
      input.session.declaredContentHash ?? null,
      input.session.bucket,
      input.session.storageEndpoint,
      input.session.expiresAt,
      input.session.storageProvider ?? null,
      input.session.storageObjectKey ?? null,
      input.session.storageBucket ?? null,
      input.session.gatewayUrl ?? null,
      input.session.ipfsCid ?? null,
      input.session.contentHash ?? null,
      input.session.sizeBytes ?? null,
      input.session.createdAt,
      input.session.updatedAt,
    ],
  })

  const created = await getSessionRow({
    client: input.client,
    communityId: input.session.communityId,
    sessionId: input.session.songArtifactUploadSessionId,
  })
  if (!created) {
    throw internalError("Song artifact upload session is missing after insert")
  }
  return created
}

export async function getSongArtifactUploadSession(input: {
  client: Client
  communityId: string
  sessionId: string
}): Promise<SongArtifactUploadSessionRow | null> {
  return await getSessionRow(input)
}

export async function isSongArtifactUploadContentHashServerVerified(input: {
  client: Client
  communityId: string
  songArtifactUploadId: string
}): Promise<boolean> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT upload_mode
      FROM song_artifact_upload_sessions
      WHERE community_id = ?1
        AND song_artifact_upload_id = ?2
      ORDER BY created_at DESC
      LIMIT 1
    `,
    args: [input.communityId, input.songArtifactUploadId.replace(/^sau_/, "")],
  })
  if (!row) {
    // Proxy uploads do not create sessions and hash the received bytes server-side.
    return true
  }
  return requiredString(row, "upload_mode") === "proxy"
}

export async function requireSongArtifactUploadSession(input: {
  client: Client
  communityId: string
  sessionId: string
}): Promise<SongArtifactUploadSessionRow> {
  const session = await getSessionRow(input)
  if (!session) {
    throw notFoundError("Song artifact upload session not found")
  }
  return session
}

export async function transitionSongArtifactUploadSession(input: {
  client: Client
  communityId: string
  sessionId: string
  fromStatus: SongArtifactUploadSessionStatus | ReadonlyArray<SongArtifactUploadSessionStatus>
  toStatus: SongArtifactUploadSessionStatus
  updatedAt: string
  fields?: SessionTransitionFields
}): Promise<SongArtifactUploadSessionRow | null> {
  const args: unknown[] = []
  const addArg = (value: unknown): string => {
    args.push(value)
    return `?${args.length}`
  }
  const assignments = [
    `status = ${addArg(input.toStatus)}`,
    `updated_at = ${addArg(input.updatedAt)}`,
  ]
  const fields = input.fields ?? {}

  for (const [column, value] of Object.entries(fields)) {
    if (value === undefined) continue
    assignments.push(`${column} = ${addArg(value)}`)
  }

  const fromStatuses = Array.isArray(input.fromStatus) ? input.fromStatus : [input.fromStatus]
  const communityIdPlaceholder = addArg(input.communityId)
  const sessionIdPlaceholder = addArg(input.sessionId)
  const fromStatusPlaceholders = fromStatuses.map((status) => addArg(status))

  const result = await input.client.execute({
    sql: `
      UPDATE song_artifact_upload_sessions
      SET ${assignments.join(", ")}
      WHERE community_id = ${communityIdPlaceholder}
        AND song_artifact_upload_session_id = ${sessionIdPlaceholder}
        AND status IN (${fromStatusPlaceholders.join(", ")})
    `,
    args,
  })

  if ((result.rowsAffected ?? 0) < 1) {
    return null
  }

  return await getSessionRow({
    client: input.client,
    communityId: input.communityId,
    sessionId: input.sessionId,
  })
}

export async function markSongArtifactUploadSessionUploaded(input: {
  client: Client
  communityId: string
  sessionId: string
  storageProvider: SongArtifactStorageProvider
  storageObjectKey: string
  storageBucket: string
  gatewayUrl: string
  ipfsCid: string | null
  contentHash: string
  sizeBytes: number
  completedAt: string
  updatedAt: string
}): Promise<SongArtifactUploadSessionRow | null> {
  return await transitionSongArtifactUploadSession({
    client: input.client,
    communityId: input.communityId,
    sessionId: input.sessionId,
    fromStatus: "head_verifying",
    toStatus: "uploaded",
    updatedAt: input.updatedAt,
    fields: {
      storage_provider: input.storageProvider,
      storage_object_key: input.storageObjectKey,
      storage_bucket: input.storageBucket,
      gateway_url: input.gatewayUrl,
      ipfs_cid: input.ipfsCid,
      content_hash: input.contentHash,
      size_bytes: input.sizeBytes,
      completed_at: input.completedAt,
    },
  })
}

export async function markSongArtifactUploadSessionAborted(input: {
  client: Client
  communityId: string
  sessionId: string
  reason: string
  abortedAt: string
  updatedAt: string
}): Promise<SongArtifactUploadSessionRow | null> {
  return await transitionSongArtifactUploadSession({
    client: input.client,
    communityId: input.communityId,
    sessionId: input.sessionId,
    fromStatus: ACTIVE_SESSION_STATUSES,
    toStatus: "aborted",
    updatedAt: input.updatedAt,
    fields: {
      aborted_at: input.abortedAt,
      aborted_reason: input.reason,
    },
  })
}

export async function listStaleSongArtifactUploadSessions(input: {
  client: Client
  communityId: string
  now: string
  limit: number
}): Promise<SongArtifactUploadSessionRow[]> {
  const result = await input.client.execute({
    sql: `
      SELECT ${SESSION_COLUMNS}
      FROM song_artifact_upload_sessions
      WHERE community_id = ?1
        AND status IN ('created', 'parts_uploading', 'completing', 'head_verifying', 'aborting')
        AND expires_at < ?2
      ORDER BY expires_at ASC
      LIMIT ?3
    `,
    args: [input.communityId, input.now, input.limit],
  })

  return result.rows.map(toSongArtifactUploadSessionRow)
}
