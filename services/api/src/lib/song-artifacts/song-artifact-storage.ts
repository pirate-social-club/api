import { notFoundError, providerUnavailable } from "../errors"
import { sha256Hex, toArrayBuffer } from "../crypto"
import { resolveFilebaseConfig } from "../storage/filebase-config"
import { buildS3SignedRequest, EMPTY_SHA256_HEX } from "../storage/s3-signing"
import type { Env } from "../../types"
import {
  assertSongArtifactMimeType,
  assertSongArtifactSize,
  extensionForSongArtifactMimeType,
  type SongArtifactKind,
} from "./song-artifact-storage-policy"
export {
  assertSongArtifactMimeType,
  assertSongArtifactSize,
  type SongArtifactKind,
} from "./song-artifact-storage-policy"

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
    `${songArtifactUploadId}.${extensionForSongArtifactMimeType(mimeType)}`,
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
    config: resolveFilebaseConfig(input.env, "music"),
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

  const config = resolveFilebaseConfig(input.env, "music")
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
  storageProvider: "filebase"
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
    config: resolveFilebaseConfig(input.env, "music"),
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
      `Filebase song upload failed with status ${response.status}${responseText ? `: ${responseText}` : ""}`,
    )
  }

  const config = resolveFilebaseConfig(input.env, "music")
  const storageRef = buildSongArtifactContentUrl(input.origin, input.communityId, input.songArtifactUploadId)
  return {
    storageRef,
    storageProvider: "filebase",
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
}): Promise<Response> {
  const request = await buildS3SignedRequest({
    method: "GET",
    config: resolveFilebaseConfig(input.env, "music"),
    objectKey: input.objectKey,
    payloadHash: EMPTY_SHA256_HEX,
  })
  const upstream = await fetch(request)
  if (upstream.status === 404) {
    throw notFoundError("Song artifact content not found")
  }
  if (!upstream.ok) {
    const responseText = await upstream.text().catch(() => "")
    throw providerUnavailable(
      `Filebase song fetch failed with status ${upstream.status}${responseText ? `: ${responseText}` : ""}`,
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
  headers.set("cache-control", "public, max-age=31536000, immutable")

  return new Response(upstream.body, {
    status: 200,
    headers,
  })
}
