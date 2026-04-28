import { badRequestError } from "../errors"

export type SongArtifactKind =
  | "primary_audio"
  | "cover_art"
  | "preview_audio"
  | "canvas_video"
  | "instrumental_audio"
  | "vocal_audio"

const allowedMimeTypesByKind: Record<SongArtifactKind, Set<string>> = {
  primary_audio: new Set([
    "audio/aac",
    "audio/flac",
    "audio/m4a",
    "audio/mp3",
    "audio/mp4",
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "audio/webm",
    "audio/x-m4a",
    "audio/x-wav",
  ]),
  preview_audio: new Set([
    "audio/aac",
    "audio/flac",
    "audio/m4a",
    "audio/mp3",
    "audio/mp4",
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "audio/webm",
    "audio/x-m4a",
    "audio/x-wav",
  ]),
  instrumental_audio: new Set([
    "audio/aac",
    "audio/flac",
    "audio/m4a",
    "audio/mp3",
    "audio/mp4",
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "audio/webm",
    "audio/x-m4a",
    "audio/x-wav",
  ]),
  vocal_audio: new Set([
    "audio/aac",
    "audio/flac",
    "audio/m4a",
    "audio/mp3",
    "audio/mp4",
    "audio/mpeg",
    "audio/ogg",
    "audio/wav",
    "audio/webm",
    "audio/x-m4a",
    "audio/x-wav",
  ]),
  cover_art: new Set([
    "image/avif",
    "image/gif",
    "image/jpeg",
    "image/png",
    "image/webp",
  ]),
  canvas_video: new Set([
    "video/mp4",
    "video/quicktime",
    "video/webm",
  ]),
}

const maxBytesByKind: Record<SongArtifactKind, number> = {
  primary_audio: 64 * 1024 * 1024,
  preview_audio: 32 * 1024 * 1024,
  instrumental_audio: 64 * 1024 * 1024,
  vocal_audio: 64 * 1024 * 1024,
  cover_art: 12 * 1024 * 1024,
  canvas_video: 64 * 1024 * 1024,
}

export function assertSongArtifactMimeType(kind: SongArtifactKind, mimeType: string): void {
  const normalized = mimeType.trim().toLowerCase()
  if (!allowedMimeTypesByKind[kind].has(normalized)) {
    throw badRequestError(`Unsupported ${kind} mime type: ${mimeType}`)
  }
}

export function assertSongArtifactSize(kind: SongArtifactKind, sizeBytes: number): void {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw badRequestError(`${kind} upload is empty`)
  }
  if (sizeBytes > maxBytesByKind[kind]) {
    throw badRequestError(`${kind} exceeds the ${Math.floor(maxBytesByKind[kind] / (1024 * 1024))}MB limit`)
  }
}

export function extensionForSongArtifactMimeType(mimeType: string): string {
  switch (mimeType) {
    case "audio/aac":
      return "aac"
    case "audio/flac":
      return "flac"
    case "audio/m4a":
    case "audio/x-m4a":
      return "m4a"
    case "audio/mp3":
    case "audio/mpeg":
      return "mp3"
    case "audio/mp4":
      return "mp4"
    case "audio/ogg":
      return "ogg"
    case "audio/wav":
    case "audio/x-wav":
      return "wav"
    case "audio/webm":
      return "webm"
    case "image/gif":
      return "gif"
    case "image/avif":
      return "avif"
    case "image/jpeg":
      return "jpg"
    case "image/png":
      return "png"
    case "image/webp":
      return "webp"
    case "video/mp4":
      return "mp4"
    case "video/quicktime":
      return "mov"
    case "video/webm":
      return "webm"
    default:
      throw badRequestError(`Unsupported media type: ${mimeType}`)
  }
}
