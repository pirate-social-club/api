import type { Post, SongArtifactBundle, SongArtifactUpload } from "../../types"

export function descriptorFromUpload(upload: SongArtifactUpload): {
  storage_ref: string
  mime_type: string
  size_bytes?: number | null
  content_hash?: string | null
  duration_ms?: number | null
} {
  return {
    storage_ref: upload.gateway_url || upload.storage_ref,
    mime_type: upload.mime_type,
    size_bytes: upload.size_bytes ?? null,
    content_hash: upload.content_hash ?? null,
    duration_ms: null,
  }
}

export function imageDescriptorFromUpload(upload: SongArtifactUpload): {
  storage_ref: string
  mime_type: string
  size_bytes?: number | null
  content_hash?: string | null
  width?: number | null
  height?: number | null
} {
  return {
    storage_ref: upload.gateway_url || upload.storage_ref,
    mime_type: upload.mime_type,
    size_bytes: upload.size_bytes ?? null,
    content_hash: upload.content_hash ?? null,
    width: null,
    height: null,
  }
}

export function videoDescriptorFromUpload(upload: SongArtifactUpload): {
  storage_ref: string
  mime_type: string
  size_bytes?: number | null
  content_hash?: string | null
  duration_ms?: number | null
  clip_start_ms?: number | null
  clip_duration_ms?: number | null
  width?: number | null
  height?: number | null
  poster_ref?: string | null
  poster_mime_type?: string | null
  poster_size_bytes?: number | null
  poster_width?: number | null
  poster_height?: number | null
  poster_frame_ms?: number | null
} {
  return {
    storage_ref: upload.gateway_url || upload.storage_ref,
    mime_type: upload.mime_type,
    size_bytes: upload.size_bytes ?? null,
    content_hash: upload.content_hash ?? null,
    duration_ms: null,
    clip_start_ms: null,
    clip_duration_ms: null,
    width: null,
    height: null,
  }
}

export function resolveBundlePostAnalysis(bundle: SongArtifactBundle): {
  analysisState: Post["analysis_state"]
  contentSafetyState: Post["content_safety_state"]
  ageGatePolicy: Post["age_gate_policy"]
} {
  const moderation = bundle.moderation_result && typeof bundle.moderation_result === "object"
    ? bundle.moderation_result as {
        analysis_state?: Post["analysis_state"]
        content_safety_state?: Post["content_safety_state"]
        age_gate_policy?: Post["age_gate_policy"]
      }
    : {}
  return {
    analysisState: moderation.analysis_state ?? "allow",
    contentSafetyState: moderation.content_safety_state ?? "safe",
    ageGatePolicy: moderation.age_gate_policy ?? "none",
  }
}
