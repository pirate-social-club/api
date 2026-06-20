import { numberOrNull, requiredString, rowValue, stringOrNull } from "../sql-row"
import type {
  SongArtifactBundle,
  SongArtifactUpload,
} from "../../types"
import { unixSeconds } from "../../serializers/time"

export type SongArtifactUploadRow = {
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
  ipfs_cid: string | null
  created_at: string
  updated_at: string
}

export type SongArtifactBundleRow = {
  song_artifact_bundle_id: string
  community_id: string
  creator_user_id: string
  status: SongArtifactBundle["status"]
  title: string | null
  primary_audio_json: string
  lyrics_text: string
  lyrics_sha256: string
  genius_annotations_url: string | null
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

export function toSongArtifactUploadRow(row: unknown): SongArtifactUploadRow {
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
    ipfs_cid: stringOrNull(rowValue(row, "ipfs_cid")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

export function serializeSongArtifactUpload(row: SongArtifactUploadRow): SongArtifactUpload {
  return {
    id: `sau_${row.song_artifact_upload_id}`,
    object: "song_artifact_upload",
    community: `com_${row.community_id}`,
    uploader_user: `usr_${row.uploader_user_id}`,
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
    ipfs_cid: row.ipfs_cid,
    upload_url: row.storage_ref,
    created: unixSeconds(row.created_at),
  }
}

export function toSongArtifactBundleRow(row: unknown): SongArtifactBundleRow {
  return {
    song_artifact_bundle_id: requiredString(row, "song_artifact_bundle_id"),
    community_id: requiredString(row, "community_id"),
    creator_user_id: requiredString(row, "creator_user_id"),
    status: requiredString(row, "status") as SongArtifactBundle["status"],
    title: stringOrNull(rowValue(row, "title")),
    primary_audio_json: requiredString(row, "primary_audio_json"),
    lyrics_text: stringOrNull(rowValue(row, "lyrics_text")) ?? "",
    lyrics_sha256: requiredString(row, "lyrics_sha256"),
    genius_annotations_url: stringOrNull(rowValue(row, "genius_annotations_url")),
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

export function serializeSongArtifactBundle(row: SongArtifactBundleRow): SongArtifactBundle {
  const primaryAudio = parseJsonValue<SongArtifactBundle["primary_audio"]>(row.primary_audio_json, {
    storage_ref: "",
    mime_type: "",
  })
  return {
    id: `sab_${row.song_artifact_bundle_id}`,
    object: "song_artifact_bundle",
    community: `com_${row.community_id}`,
    creator_user: `usr_${row.creator_user_id}`,
    status: row.status,
    title: row.title?.trim() || "Untitled track",
    primary_audio: primaryAudio,
    media_refs: primaryAudio.storage_ref && primaryAudio.mime_type
      ? [{
          storage_ref: primaryAudio.storage_ref,
          mime_type: primaryAudio.mime_type,
          size_bytes: primaryAudio.size_bytes ?? null,
          content_hash: primaryAudio.content_hash ?? null,
          duration_ms: primaryAudio.duration_ms ?? null,
          decentralized_storage: primaryAudio.decentralized_storage ?? null,
        }]
      : [],
    lyrics: row.lyrics_text,
    lyrics_sha256: row.lyrics_sha256,
    genius_annotations_url: row.genius_annotations_url,
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
    created: unixSeconds(row.created_at),
  }
}
