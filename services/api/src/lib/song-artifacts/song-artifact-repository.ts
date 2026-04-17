import type { Client } from "@libsql/client"
import { executeFirst } from "../db-helpers"
import { internalError, notFoundError } from "../errors"
import { numberOrNull, requiredString, rowValue, stringOrNull } from "../sql-row"
import type {
  CreateSongArtifactBundleRequest,
  CreateSongArtifactUploadRequest,
  SongArtifactBundle,
  SongArtifactUpload,
} from "../../types"

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
  storage_provider: SongArtifactUpload["storage_provider"]
  storage_bucket: string | null
  storage_object_key: string | null
  storage_endpoint: string | null
  gateway_url: string | null
  created_at: string
  updated_at: string
}

type SongArtifactBundleRow = {
  song_artifact_bundle_id: string
  community_id: string
  creator_user_id: string
  status: SongArtifactBundle["status"]
  primary_audio_json: string
  lyrics_text: string
  lyrics_sha256: string
  cover_art_json: string | null
  preview_audio_json: string | null
  preview_window_json: string | null
  preview_status: SongArtifactBundle["preview_status"]
  preview_error: string | null
  canvas_video_json: string | null
  instrumental_audio_json: string | null
  vocal_audio_json: string | null
  translation_status: SongArtifactBundle["translation_status"]
  translation_error: string | null
  translated_lyrics_ref: string | null
  translated_lyrics_json: string | null
  alignment_status: SongArtifactBundle["alignment_status"]
  alignment_error: string | null
  timed_lyrics_ref: string | null
  timed_lyrics_json: string | null
  moderation_status: SongArtifactBundle["moderation_status"]
  moderation_error: string | null
  moderation_result_ref: string | null
  moderation_result_json: string | null
  created_at: string
  updated_at: string
}

function parseJsonValue<T>(value: string | null, fallback: T): T {
  if (!value?.trim()) {
    return fallback
  }
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function toSongArtifactUploadRow(row: unknown): SongArtifactUploadRow {
  return {
    song_artifact_upload_id: requiredString(row, "song_artifact_upload_id"),
    community_id: requiredString(row, "community_id"),
    uploader_user_id: requiredString(row, "uploader_user_id"),
    artifact_kind: requiredString(row, "artifact_kind") as SongArtifactUpload["artifact_kind"],
    status: requiredString(row, "status") as SongArtifactUpload["status"],
    storage_ref: requiredString(row, "storage_ref"),
    mime_type: requiredString(row, "mime_type"),
    filename: stringOrNull(rowValue(row, "filename")),
    size_bytes: numberOrNull(rowValue(row, "size_bytes")),
    content_hash: stringOrNull(rowValue(row, "content_hash")),
    storage_provider: stringOrNull(rowValue(row, "storage_provider")) as SongArtifactUpload["storage_provider"],
    storage_bucket: stringOrNull(rowValue(row, "storage_bucket")),
    storage_object_key: stringOrNull(rowValue(row, "storage_object_key")),
    storage_endpoint: stringOrNull(rowValue(row, "storage_endpoint")),
    gateway_url: stringOrNull(rowValue(row, "gateway_url")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

function serializeSongArtifactUpload(row: SongArtifactUploadRow): SongArtifactUpload {
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
    upload_url: row.storage_ref,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

function toSongArtifactBundleRow(row: unknown): SongArtifactBundleRow {
  return {
    song_artifact_bundle_id: requiredString(row, "song_artifact_bundle_id"),
    community_id: requiredString(row, "community_id"),
    creator_user_id: requiredString(row, "creator_user_id"),
    status: requiredString(row, "status") as SongArtifactBundle["status"],
    primary_audio_json: requiredString(row, "primary_audio_json"),
    lyrics_text: requiredString(row, "lyrics_text"),
    lyrics_sha256: requiredString(row, "lyrics_sha256"),
    cover_art_json: stringOrNull(rowValue(row, "cover_art_json")),
    preview_audio_json: stringOrNull(rowValue(row, "preview_audio_json")),
    preview_window_json: stringOrNull(rowValue(row, "preview_window_json")),
    preview_status: requiredString(row, "preview_status") as SongArtifactBundle["preview_status"],
    preview_error: stringOrNull(rowValue(row, "preview_error")),
    canvas_video_json: stringOrNull(rowValue(row, "canvas_video_json")),
    instrumental_audio_json: stringOrNull(rowValue(row, "instrumental_audio_json")),
    vocal_audio_json: stringOrNull(rowValue(row, "vocal_audio_json")),
    translation_status: requiredString(row, "translation_status") as SongArtifactBundle["translation_status"],
    translation_error: stringOrNull(rowValue(row, "translation_error")),
    translated_lyrics_ref: stringOrNull(rowValue(row, "translated_lyrics_ref")),
    translated_lyrics_json: stringOrNull(rowValue(row, "translated_lyrics_json")),
    alignment_status: requiredString(row, "alignment_status") as SongArtifactBundle["alignment_status"],
    alignment_error: stringOrNull(rowValue(row, "alignment_error")),
    timed_lyrics_ref: stringOrNull(rowValue(row, "timed_lyrics_ref")),
    timed_lyrics_json: stringOrNull(rowValue(row, "timed_lyrics_json")),
    moderation_status: requiredString(row, "moderation_status") as SongArtifactBundle["moderation_status"],
    moderation_error: stringOrNull(rowValue(row, "moderation_error")),
    moderation_result_ref: stringOrNull(rowValue(row, "moderation_result_ref")),
    moderation_result_json: stringOrNull(rowValue(row, "moderation_result_json")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

function serializeSongArtifactBundle(row: SongArtifactBundleRow): SongArtifactBundle {
  const primaryAudio = parseJsonValue<SongArtifactBundle["primary_audio"]>(row.primary_audio_json, {
    storage_ref: "",
    mime_type: "",
  })
  return {
    song_artifact_bundle_id: row.song_artifact_bundle_id,
    community_id: row.community_id,
    creator_user_id: row.creator_user_id,
    status: row.status,
    primary_audio: primaryAudio,
    media_refs: primaryAudio.storage_ref && primaryAudio.mime_type
      ? [{
          storage_ref: primaryAudio.storage_ref,
          mime_type: primaryAudio.mime_type,
          size_bytes: primaryAudio.size_bytes ?? null,
          content_hash: primaryAudio.content_hash ?? null,
          duration_ms: primaryAudio.duration_ms ?? null,
        }]
      : [],
    lyrics: row.lyrics_text,
    lyrics_sha256: row.lyrics_sha256,
    cover_art: parseJsonValue(row.cover_art_json, null),
    preview_audio: parseJsonValue(row.preview_audio_json, null),
    preview_window: parseJsonValue(row.preview_window_json, null),
    preview_status: row.preview_status,
    preview_error: row.preview_error,
    canvas_video: parseJsonValue(row.canvas_video_json, null),
    instrumental_audio: parseJsonValue(row.instrumental_audio_json, null),
    vocal_audio: parseJsonValue(row.vocal_audio_json, null),
    translation_status: row.translation_status,
    translation_error: row.translation_error,
    translated_lyrics_ref: row.translated_lyrics_ref,
    translated_lyrics: parseJsonValue(row.translated_lyrics_json, null),
    alignment_status: row.alignment_status,
    alignment_error: row.alignment_error,
    timed_lyrics_ref: row.timed_lyrics_ref,
    timed_lyrics: parseJsonValue(row.timed_lyrics_json, null),
    moderation_status: row.moderation_status,
    moderation_error: row.moderation_error,
    moderation_result_ref: row.moderation_result_ref,
    moderation_result: parseJsonValue(row.moderation_result_json, null),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

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

async function getSongArtifactBundleRow(
  client: Client,
  communityId: string,
  songArtifactBundleId: string,
): Promise<SongArtifactBundleRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT song_artifact_bundle_id, community_id, creator_user_id, status, primary_audio_json,
             lyrics_text, lyrics_sha256, cover_art_json, preview_audio_json, preview_window_json,
             preview_status, preview_error, canvas_video_json,
             instrumental_audio_json, vocal_audio_json, translation_status, translation_error,
             translated_lyrics_ref, translated_lyrics_json, alignment_status, alignment_error,
             timed_lyrics_ref, timed_lyrics_json, moderation_status, moderation_error,
             moderation_result_ref, moderation_result_json, created_at, updated_at
      FROM song_artifact_bundles
      WHERE community_id = ?1
        AND song_artifact_bundle_id = ?2
      LIMIT 1
    `,
    args: [communityId, songArtifactBundleId],
  })

  return row ? toSongArtifactBundleRow(row) : null
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
  const row = await executeFirst(input.client, {
    sql: `
      SELECT song_artifact_upload_id, community_id, uploader_user_id, artifact_kind, status, storage_ref,
             mime_type, filename, size_bytes, content_hash, storage_provider, storage_bucket,
             storage_object_key, storage_endpoint, gateway_url, created_at, updated_at
      FROM song_artifact_uploads
      WHERE community_id = ?1
        AND status = 'uploaded'
        AND (?2 IS NULL OR artifact_kind = ?2)
        AND (storage_ref = ?3 OR gateway_url = ?3)
      ORDER BY updated_at DESC
      LIMIT 1
    `,
    args: [input.communityId, input.artifactKind ?? null, input.storageRef],
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

export async function createSongArtifactBundleDraft(input: {
  client: Client
  communityId: string
  userId: string
  songArtifactBundleId: string
  body: CreateSongArtifactBundleRequest
  primaryAudio: SongArtifactBundle["primary_audio"]
  coverArt: SongArtifactBundle["cover_art"]
  previewAudio: SongArtifactBundle["preview_audio"]
  canvasVideo: SongArtifactBundle["canvas_video"]
  instrumentalAudio: SongArtifactBundle["instrumental_audio"]
  vocalAudio: SongArtifactBundle["vocal_audio"]
  lyricsSha256: string
  createdAt: string
}): Promise<SongArtifactBundle> {
  await input.client.execute({
    sql: `
      INSERT INTO song_artifact_bundles (
        song_artifact_bundle_id, community_id, creator_user_id, status, primary_audio_json,
        lyrics_text, lyrics_sha256, cover_art_json, preview_audio_json, canvas_video_json,
        instrumental_audio_json, vocal_audio_json, translation_status,
        translation_error, translated_lyrics_ref, translated_lyrics_json, alignment_status,
        alignment_error, timed_lyrics_ref, timed_lyrics_json, moderation_status, moderation_error,
        moderation_result_ref, moderation_result_json, preview_window_json, preview_status,
        preview_error, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, 'validating', ?4,
        ?5, ?6, ?7, ?8, ?9,
        ?10, ?11, 'pending',
        NULL, NULL, NULL, 'processing',
        NULL, NULL, NULL, 'processing', NULL,
        NULL, NULL, ?12, 'completed',
        NULL, ?13, ?13
      )
    `,
    args: [
      input.songArtifactBundleId,
      input.communityId,
      input.userId,
      JSON.stringify(input.primaryAudio),
      input.body.lyrics,
      input.lyricsSha256,
      input.coverArt ? JSON.stringify(input.coverArt) : null,
      input.previewAudio ? JSON.stringify(input.previewAudio) : null,
      input.canvasVideo ? JSON.stringify(input.canvasVideo) : null,
      input.instrumentalAudio ? JSON.stringify(input.instrumentalAudio) : null,
      input.vocalAudio ? JSON.stringify(input.vocalAudio) : null,
      input.body.preview_window ? JSON.stringify(input.body.preview_window) : null,
      input.createdAt,
    ],
  })

  const created = await getSongArtifactBundleRow(input.client, input.communityId, input.songArtifactBundleId)
  if (!created) {
    throw internalError("Song artifact bundle is missing after insert")
  }
  return serializeSongArtifactBundle(created)
}

export async function finalizeSongArtifactBundle(input: {
  client: Client
  communityId: string
  songArtifactBundleId: string
  status: SongArtifactBundle["status"]
  translationStatus: SongArtifactBundle["translation_status"]
  translationError: string | null
  translatedLyricsRef: string | null
  translatedLyrics: Record<string, unknown> | null
  alignmentStatus: SongArtifactBundle["alignment_status"]
  alignmentError: string | null
  timedLyricsRef: string | null
  timedLyrics: Record<string, unknown> | null
  moderationStatus: SongArtifactBundle["moderation_status"]
  moderationError: string | null
  moderationResultRef: string | null
  moderationResult: Record<string, unknown> | null
  previewStatus: SongArtifactBundle["preview_status"]
  previewError: string | null
  updatedAt: string
}): Promise<SongArtifactBundle> {
  await input.client.execute({
    sql: `
      UPDATE song_artifact_bundles
      SET status = ?3,
          translation_status = ?4,
          translation_error = ?5,
          translated_lyrics_ref = ?6,
          translated_lyrics_json = ?7,
          alignment_status = ?8,
          alignment_error = ?9,
          timed_lyrics_ref = ?10,
          timed_lyrics_json = ?11,
          moderation_status = ?12,
          moderation_error = ?13,
          moderation_result_ref = ?14,
          moderation_result_json = ?15,
          preview_status = ?16,
          preview_error = ?17,
          updated_at = ?18
      WHERE community_id = ?1
        AND song_artifact_bundle_id = ?2
    `,
    args: [
      input.communityId,
      input.songArtifactBundleId,
      input.status,
      input.translationStatus,
      input.translationError,
      input.translatedLyricsRef,
      input.translatedLyrics ? JSON.stringify(input.translatedLyrics) : null,
      input.alignmentStatus,
      input.alignmentError,
      input.timedLyricsRef,
      input.timedLyrics ? JSON.stringify(input.timedLyrics) : null,
      input.moderationStatus,
      input.moderationError,
      input.moderationResultRef,
      input.moderationResult ? JSON.stringify(input.moderationResult) : null,
      input.previewStatus,
      input.previewError,
      input.updatedAt,
    ],
  })

  const updated = await getSongArtifactBundleRow(input.client, input.communityId, input.songArtifactBundleId)
  if (!updated) {
    throw internalError("Song artifact bundle is missing after finalize")
  }
  return serializeSongArtifactBundle(updated)
}

export async function getSongArtifactBundle(
  client: Client,
  communityId: string,
  songArtifactBundleId: string,
): Promise<SongArtifactBundle | null> {
  const row = await getSongArtifactBundleRow(client, communityId, songArtifactBundleId)
  return row ? serializeSongArtifactBundle(row) : null
}

export async function markSongArtifactBundleConsumed(input: {
  client: Client
  communityId: string
  songArtifactBundleId: string
  updatedAt: string
}): Promise<SongArtifactBundle> {
  await input.client.execute({
    sql: `
      UPDATE song_artifact_bundles
      SET status = 'consumed',
          updated_at = ?3
      WHERE community_id = ?1
        AND song_artifact_bundle_id = ?2
    `,
    args: [input.communityId, input.songArtifactBundleId, input.updatedAt],
  })

  const updated = await getSongArtifactBundleRow(input.client, input.communityId, input.songArtifactBundleId)
  if (!updated) {
    throw internalError("Song artifact bundle is missing after consume")
  }
  return serializeSongArtifactBundle(updated)
}

export async function updateSongArtifactBundleModerationResult(input: {
  client: Client
  communityId: string
  songArtifactBundleId: string
  moderationResult: Record<string, unknown> | null
  updatedAt: string
}): Promise<SongArtifactBundle> {
  await input.client.execute({
    sql: `
      UPDATE song_artifact_bundles
      SET moderation_result_json = ?3,
          updated_at = ?4
      WHERE community_id = ?1
        AND song_artifact_bundle_id = ?2
    `,
    args: [
      input.communityId,
      input.songArtifactBundleId,
      input.moderationResult ? JSON.stringify(input.moderationResult) : null,
      input.updatedAt,
    ],
  })

  const updated = await getSongArtifactBundleRow(input.client, input.communityId, input.songArtifactBundleId)
  if (!updated) {
    throw internalError("Song artifact bundle is missing after moderation result update")
  }
  return serializeSongArtifactBundle(updated)
}
