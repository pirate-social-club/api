import type { Client } from "../sql-client"
import { executeFirst } from "../db-helpers"
import { internalError, notFoundError } from "../errors"
import type {
  CreateSongArtifactBundleRequest,
  CreateSongArtifactUploadRequest,
  SongArtifactBundle,
  SongArtifactBundleListResponse,
  SongArtifactUpload,
} from "../../types"
import {
  type SongArtifactBundleRow,
  type SongArtifactUploadRow,
  serializeSongArtifactBundle,
  serializeSongArtifactUpload,
  toSongArtifactBundleRow,
  toSongArtifactUploadRow,
} from "./song-artifact-serialization"
import { ensureSongArtifactBundleGeniusAnnotationsUrlColumn } from "./ensure-song-artifact-bundle-genius-annotations-url-column"
import { ensureSongArtifactBundleTitleColumn } from "./ensure-song-artifact-bundle-title-column"
import type { SongArtifactStorageProvider } from "./song-artifact-storage-provider"

async function getSongArtifactUploadRow(
  client: Client,
  communityId: string,
  songArtifactUploadId: string,
): Promise<SongArtifactUploadRow | null> {
  const row = await executeFirst(client, {
    sql: `
      SELECT song_artifact_upload_id, community_id, uploader_user_id, artifact_kind, status, storage_ref,
             mime_type, filename, size_bytes, content_hash, storage_provider, storage_bucket,
             storage_object_key, storage_endpoint, gateway_url, ipfs_cid, created_at, updated_at
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
  await ensureSongArtifactBundleTitleColumn(client)
  await ensureSongArtifactBundleGeniusAnnotationsUrlColumn(client)
  const row = await executeFirst(client, {
    sql: `
      SELECT song_artifact_bundle_id, community_id, creator_user_id, status, primary_audio_json,
             title, lyrics_text, lyrics_sha256, genius_annotations_url,
             cover_art_json, preview_audio_json, preview_window_json,
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
        storage_object_key, storage_endpoint, gateway_url, ipfs_cid, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, ?4, 'pending_upload', ?5,
        ?6, ?7, ?8, ?9, NULL, NULL,
        NULL, NULL, NULL, NULL, ?10, ?10
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
             storage_object_key, storage_endpoint, gateway_url, ipfs_cid, created_at, updated_at
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
  storageProvider: SongArtifactStorageProvider
  storageBucket: string
  storageObjectKey: string
  storageEndpoint: string
  gatewayUrl: string
  ipfsCid: string | null
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
          ipfs_cid = ?11,
          updated_at = ?12
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
      input.ipfsCid,
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
  geniusAnnotationsUrl: string | null
  createdAt: string
}): Promise<SongArtifactBundle> {
  await ensureSongArtifactBundleTitleColumn(input.client)
  await ensureSongArtifactBundleGeniusAnnotationsUrlColumn(input.client)
  await input.client.execute({
    sql: `
      INSERT INTO song_artifact_bundles (
        song_artifact_bundle_id, community_id, creator_user_id, status, primary_audio_json,
        title, lyrics_text, lyrics_sha256, cover_art_json, preview_audio_json, canvas_video_json,
        instrumental_audio_json, vocal_audio_json, translation_status,
        translation_error, translated_lyrics_ref, translated_lyrics_json, alignment_status,
        alignment_error, timed_lyrics_ref, timed_lyrics_json, moderation_status, moderation_error,
        moderation_result_ref, moderation_result_json, preview_window_json, preview_status,
        preview_error, created_at, updated_at, genius_annotations_url
      ) VALUES (
        ?1, ?2, ?3, 'validating', ?4,
        ?5, ?6, ?7, ?8, ?9, ?10,
        ?11, ?12, 'pending',
        NULL, NULL, NULL, 'processing',
        NULL, NULL, NULL, 'processing', NULL,
        NULL, NULL, ?13, 'completed',
        NULL, ?14, ?14, ?15
      )
    `,
    args: [
      input.songArtifactBundleId,
      input.communityId,
      input.userId,
      JSON.stringify(input.primaryAudio),
      input.body.title.trim(),
      input.body.lyrics,
      input.lyricsSha256,
      input.coverArt ? JSON.stringify(input.coverArt) : null,
      input.previewAudio ? JSON.stringify(input.previewAudio) : null,
      input.canvasVideo ? JSON.stringify(input.canvasVideo) : null,
      input.instrumentalAudio ? JSON.stringify(input.instrumentalAudio) : null,
      input.vocalAudio ? JSON.stringify(input.vocalAudio) : null,
      input.body.preview_window ? JSON.stringify(input.body.preview_window) : null,
      input.createdAt,
      input.geniusAnnotationsUrl,
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

export async function updateSongArtifactBundlePreview(input: {
  client: Client
  communityId: string
  songArtifactBundleId: string
  previewAudio: SongArtifactBundle["preview_audio"]
  previewStatus: SongArtifactBundle["preview_status"]
  previewError: string | null
  updatedAt: string
}): Promise<SongArtifactBundle> {
  await input.client.execute({
    sql: `
      UPDATE song_artifact_bundles
      SET preview_audio_json = ?3,
          preview_status = ?4,
          preview_error = ?5,
          updated_at = ?6
      WHERE community_id = ?1
        AND song_artifact_bundle_id = ?2
    `,
    args: [
      input.communityId,
      input.songArtifactBundleId,
      input.previewAudio ? JSON.stringify(input.previewAudio) : null,
      input.previewStatus,
      input.previewError,
      input.updatedAt,
    ],
  })

  const updated = await getSongArtifactBundleRow(input.client, input.communityId, input.songArtifactBundleId)
  if (!updated) {
    throw internalError("Song artifact bundle is missing after preview update")
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

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`)
}

export async function listSongArtifactBundles(input: {
  client: Client
  communityId: string
  creatorUserId: string
  query?: string | null
  limit: number
}): Promise<SongArtifactBundleListResponse> {
  await ensureSongArtifactBundleTitleColumn(input.client)
  await ensureSongArtifactBundleGeniusAnnotationsUrlColumn(input.client)
  const query = input.query?.trim()
  const hasQuery = Boolean(query)
  const rows = await input.client.execute({
    sql: `
      SELECT song_artifact_bundle_id, community_id, creator_user_id, status, primary_audio_json,
             title, lyrics_text, lyrics_sha256, genius_annotations_url,
             cover_art_json, preview_audio_json, preview_window_json,
             preview_status, preview_error, canvas_video_json,
             instrumental_audio_json, vocal_audio_json, translation_status, translation_error,
             translated_lyrics_ref, translated_lyrics_json, alignment_status, alignment_error,
             timed_lyrics_ref, timed_lyrics_json, moderation_status, moderation_error,
             moderation_result_ref, moderation_result_json, created_at, updated_at
      FROM song_artifact_bundles
      WHERE community_id = ?1
        AND creator_user_id = ?2
        AND status = 'ready'
        ${hasQuery ? "AND LOWER(title) LIKE ?3 ESCAPE '\\'" : ""}
      ORDER BY updated_at DESC, song_artifact_bundle_id DESC
      LIMIT ?${hasQuery ? "4" : "3"}
    `,
    args: hasQuery
      ? [input.communityId, input.creatorUserId, `%${escapeLikePattern(query!.toLowerCase())}%`, input.limit]
      : [input.communityId, input.creatorUserId, input.limit],
  })

  return {
    items: rows.rows.map((row) => serializeSongArtifactBundle(toSongArtifactBundleRow(row))),
    next_cursor: null,
  }
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
