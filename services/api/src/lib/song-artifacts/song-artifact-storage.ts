import { badRequestError, notFoundError, providerUnavailable } from "../errors"
import { sha256Hex, toArrayBuffer } from "../crypto"
import { readFilebaseCid } from "../storage/filebase-cid"
import { resolveFilebaseConfig } from "../storage/filebase-config"
import { buildS3SignedRequest, EMPTY_SHA256_HEX } from "../storage/s3-signing"
import type { Env } from "../../env"
import { FILEBASE_SONG_ARTIFACT_STORAGE_PROVIDER } from "./song-artifact-storage-provider"

export type SongArtifactKind =
  | "primary_audio"
  | "cover_art"
  | "preview_audio"
  | "preview_video"
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
  preview_video: new Set([
    "video/mp4",
    "video/quicktime",
    "video/webm",
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
  preview_video: 64 * 1024 * 1024,
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

function normalizePayloadHashHex(payloadHashHex: string | null | undefined): string | null {
  const normalized = payloadHashHex?.trim().replace(/^0x/i, "").toLowerCase() || null
  if (normalized && !/^[a-f0-9]{64}$/.test(normalized)) {
    throw badRequestError("payloadHashHex must be a SHA-256 hex digest")
  }
  return normalized
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

export function buildSongArtifactObjectKey(
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

export function buildIpfsGatewayUrl(env: Env, cid: string): string {
  const gateway = String(env.IPFS_GATEWAY_URL || "https://dweb.link/ipfs").trim()
  return `${gateway.replace(/\/+$/, "")}/${encodeURIComponent(cid)}`
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
  ipfsCid: string
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

  const ipfsCid = await readFilebaseCid({ response })
  const config = resolveFilebaseConfig(input.env)
  return {
    storageBucket: config.bucket,
    storageObjectKey: input.objectKey,
    storageEndpoint: config.endpoint.toString(),
    contentHash: `0x${payloadHash}`,
    ipfsCid,
  }
}

export async function uploadSongArtifactBytes(input: {
  env: Env
  communityId: string
  songArtifactUploadId: string
  artifactKind: SongArtifactKind
  mimeType: string
  bytes: Uint8Array
  payloadHashHex?: string | null
  origin: string
}): Promise<{
  storageRef: string
  storageProvider: typeof FILEBASE_SONG_ARTIFACT_STORAGE_PROVIDER
  storageBucket: string
  storageObjectKey: string
  storageEndpoint: string
  gatewayUrl: string
  contentHash: string
  ipfsCid: string
}> {
  const normalizedMimeType = input.mimeType.trim().toLowerCase()
  assertSongArtifactMimeType(input.artifactKind, normalizedMimeType)
  assertSongArtifactSize(input.artifactKind, input.bytes.byteLength)

  const payloadHash = normalizePayloadHashHex(input.payloadHashHex) || await sha256Hex(input.bytes)
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

  const ipfsCid = await readFilebaseCid({ response })
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
    ipfsCid,
  }
}

// Filebase serves objects from IPFS. A cold object (not yet warm at the
// gateway) can fail a GET — especially a range request, which players always
// issue — with a transient 5xx or a network error until it is fetched in. The
// next request then succeeds, which is why the player shows "could not be
// loaded" only on first load. Retry a few times with short backoff so a
// cold-fetch hiccup is absorbed server-side; the success is cached (immutable)
// by Cloudflare so later range requests are fast.
const SONG_ARTIFACT_FETCH_MAX_ATTEMPTS = 3
const SONG_ARTIFACT_FETCH_BACKOFF_MS = [300, 800]

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function fetchSongArtifactBytes(input: {
  env: Env
  objectKey: string
  rangeHeader?: string | null
}): Promise<Response> {
  const rangeHeader = input.rangeHeader?.trim()
  const config = resolveFilebaseConfig(input.env)
  let lastStatus = 0
  let lastDetail = ""

  for (let attempt = 1; attempt <= SONG_ARTIFACT_FETCH_MAX_ATTEMPTS; attempt += 1) {
    const request = await buildS3SignedRequest({
      method: "GET",
      config,
      objectKey: input.objectKey,
      payloadHash: EMPTY_SHA256_HEX,
      headers: rangeHeader ? { range: rangeHeader } : undefined,
    })

    let upstream: Response
    try {
      upstream = await fetch(request)
    } catch (error) {
      lastStatus = 0
      lastDetail = error instanceof Error ? error.message : String(error)
      if (attempt < SONG_ARTIFACT_FETCH_MAX_ATTEMPTS) {
        await delay(SONG_ARTIFACT_FETCH_BACKOFF_MS[attempt - 1] ?? 800)
        continue
      }
      throw providerUnavailable(`Filebase artifact fetch failed: ${lastDetail}`)
    }

    if (upstream.status === 404) {
      throw notFoundError("Song artifact content not found")
    }
    if (!upstream.ok) {
      lastStatus = upstream.status
      lastDetail = await upstream.text().catch(() => "")
      // 5xx is typically a transient cold-fetch from IPFS; retry. Other
      // statuses (e.g. 403, 416) are not transient, so surface them.
      if (upstream.status >= 500 && attempt < SONG_ARTIFACT_FETCH_MAX_ATTEMPTS) {
        await delay(SONG_ARTIFACT_FETCH_BACKOFF_MS[attempt - 1] ?? 800)
        continue
      }
      throw providerUnavailable(
        `Filebase artifact fetch failed with status ${upstream.status}${lastDetail ? `: ${lastDetail}` : ""}`,
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

  throw providerUnavailable(
    `Filebase artifact fetch failed with status ${lastStatus}${lastDetail ? `: ${lastDetail}` : ""}`,
  )
}
