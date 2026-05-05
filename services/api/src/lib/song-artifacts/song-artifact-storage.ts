import { badRequestError, notFoundError, providerUnavailable } from "../errors"
import { sha256Hex, toArrayBuffer } from "../crypto"
import { resolveFilebaseConfig } from "../storage/filebase-config"
import { buildS3SignedRequest, EMPTY_SHA256_HEX } from "../storage/s3-signing"
import type { Env } from "../../env"
import { FILEBASE_SONG_ARTIFACT_STORAGE_PROVIDER } from "./song-artifact-storage-provider"

export type SongArtifactKind =
  | "primary_audio"
  | "cover_art"
  | "preview_audio"
  | "canvas_video"
  | "instrumental_audio"
  | "vocal_audio"
  | "primary_video"

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
  primary_video: new Set([
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
  primary_video: 64 * 1024 * 1024,
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

function extensionForMimeType(mimeType: string): string {
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

export function buildSongArtifactContentUrl(
  origin: string,
  communityId: string,
  songArtifactUploadId: string,
): string {
  return new URL(
    `/communities/${encodeURIComponent(communityId)}/song-artifact-uploads/${encodeURIComponent(songArtifactUploadId)}/content`,
    origin,
  ).toString()
}

export function buildPublicSongArtifactContentUrl(
  origin: string,
  communityId: string,
  songArtifactUploadId: string,
): string {
  return new URL(
    `/public-communities/${encodeURIComponent(communityId)}/song-artifact-uploads/${encodeURIComponent(songArtifactUploadId)}/content`,
    origin,
  ).toString()
}

function buildSongArtifactObjectKey(
  communityId: string,
  songArtifactUploadId: string,
  kind: SongArtifactKind,
  mimeType: string,
): string {
  return [
    "song-artifacts",
    communityId,
    kind,
    `${songArtifactUploadId}.${extensionForMimeType(mimeType)}`,
  ].join("/")
}

export function buildFilebaseObjectUrl(origin: string, path: string): string {
  return new URL(path, origin).toString()
}

export async function uploadFilebaseObject(input: {
  env: Env
  objectKey: string
  mimeType: string
  bytes: Uint8Array
}): Promise<{
  storageBucket: string
  storageObjectKey: string
  storageEndpoint: string
  contentHash: string
}> {
  const normalizedMimeType = input.mimeType.trim().toLowerCase()
  const payloadHash = await sha256Hex(input.bytes)
  const request = await buildS3SignedRequest({
    method: "PUT",
    config: resolveFilebaseConfig(input.env),
    objectKey: input.objectKey,
    payloadHash,
    headers: {
      "content-type": normalizedMimeType,
    },
    body: toArrayBuffer(input.bytes),
  })
  const response = await fetch(request)
  if (!response.ok) {
    const responseText = await response.text().catch(() => "")
    throw providerUnavailable(
      `Filebase object upload failed with status ${response.status}${responseText ? `: ${responseText}` : ""}`,
    )
  }

  const config = resolveFilebaseConfig(input.env)
  return {
    storageBucket: config.bucket,
    storageObjectKey: input.objectKey,
    storageEndpoint: config.endpoint.toString(),
    contentHash: `0x${payloadHash}`,
  }
}

export async function uploadSongArtifactBytes(input: {
  env: Env
  communityId: string
  songArtifactUploadId: string
  artifactKind: SongArtifactKind
  mimeType: string
  bytes: Uint8Array
  origin: string
}): Promise<{
  storageRef: string
  storageProvider: typeof FILEBASE_SONG_ARTIFACT_STORAGE_PROVIDER
  storageBucket: string
  storageObjectKey: string
  storageEndpoint: string
  gatewayUrl: string
  contentHash: string
}> {
  const normalizedMimeType = input.mimeType.trim().toLowerCase()
  assertSongArtifactMimeType(input.artifactKind, normalizedMimeType)
  assertSongArtifactSize(input.artifactKind, input.bytes.byteLength)

  const payloadHash = await sha256Hex(input.bytes)
  const objectKey = buildSongArtifactObjectKey(
    input.communityId,
    input.songArtifactUploadId,
    input.artifactKind,
    normalizedMimeType,
  )
  const request = await buildS3SignedRequest({
    method: "PUT",
    config: resolveFilebaseConfig(input.env),
    objectKey,
    payloadHash,
    headers: {
      "content-type": normalizedMimeType,
    },
    body: toArrayBuffer(input.bytes),
  })
  const response = await fetch(request)
  if (!response.ok) {
    const responseText = await response.text().catch(() => "")
    throw providerUnavailable(
      `Filebase artifact upload failed with status ${response.status}${responseText ? `: ${responseText}` : ""}`,
    )
  }

  const config = resolveFilebaseConfig(input.env)
  const storageRef = buildSongArtifactContentUrl(input.origin, input.communityId, input.songArtifactUploadId)
  return {
    storageRef,
    storageProvider: FILEBASE_SONG_ARTIFACT_STORAGE_PROVIDER,
    storageBucket: config.bucket,
    storageObjectKey: objectKey,
    storageEndpoint: config.endpoint.toString(),
    gatewayUrl: storageRef,
    contentHash: `0x${payloadHash}`,
  }
}

export async function fetchSongArtifactBytes(input: {
  env: Env
  objectKey: string
  rangeHeader?: string | null
}): Promise<Response> {
  const rangeHeader = input.rangeHeader?.trim()
  const request = await buildS3SignedRequest({
    method: "GET",
    config: resolveFilebaseConfig(input.env),
    objectKey: input.objectKey,
    payloadHash: EMPTY_SHA256_HEX,
    headers: rangeHeader ? { range: rangeHeader } : undefined,
  })
  const upstream = await fetch(request)
  if (upstream.status === 404) {
    throw notFoundError("Song artifact content not found")
  }
  if (!upstream.ok) {
    const responseText = await upstream.text().catch(() => "")
    throw providerUnavailable(
      `Filebase artifact fetch failed with status ${upstream.status}${responseText ? `: ${responseText}` : ""}`,
    )
  }

  const headers = new Headers()
  const contentType = upstream.headers.get("content-type")
  if (contentType) {
    headers.set("content-type", contentType)
  }
  const contentLength = upstream.headers.get("content-length")
  if (contentLength) {
    headers.set("content-length", contentLength)
  }
  const contentRange = upstream.headers.get("content-range")
  if (contentRange) {
    headers.set("content-range", contentRange)
  }
  const acceptRanges = upstream.headers.get("accept-ranges")
  headers.set("accept-ranges", acceptRanges || "bytes")
  headers.set("cache-control", "public, max-age=31536000, immutable")

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  })
}
