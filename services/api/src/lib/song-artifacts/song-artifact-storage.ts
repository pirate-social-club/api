import { badRequestError, internalError, notFoundError, providerUnavailable } from "../errors"
import type { Env } from "../../types"

export type SongArtifactKind =
  | "primary_audio"
  | "cover_art"
  | "preview_audio"
  | "canvas_video"
  | "instrumental_audio"
  | "vocal_audio"

type ResolvedFilebaseConfig = {
  accessKey: string
  secretKey: string
  bucket: string
  endpoint: URL
  region: string
}

const encoder = new TextEncoder()
const EMPTY_SHA256_HEX = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

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

function requireTrimmedEnv(value: string | undefined, message: string): string {
  const trimmed = String(value || "").trim()
  if (!trimmed) {
    throw internalError(message)
  }
  return trimmed
}

function resolveFilebaseConfig(env: Env): ResolvedFilebaseConfig {
  const endpointValue = String(env.FILEBASE_S3_ENDPOINT || "https://s3.filebase.com").trim()

  return {
    accessKey: requireTrimmedEnv(env.FILEBASE_S3_ACCESS_KEY, "FILEBASE_S3_ACCESS_KEY is not configured"),
    secretKey: requireTrimmedEnv(env.FILEBASE_S3_SECRET_KEY, "FILEBASE_S3_SECRET_KEY is not configured"),
    bucket: requireTrimmedEnv(
      env.FILEBASE_S3_BUCKET_MUSIC || env.FILEBASE_MEDIA_BUCKET,
      "FILEBASE_S3_BUCKET_MUSIC is not configured",
    ),
    endpoint: new URL(endpointValue),
    region: String(env.FILEBASE_S3_REGION || "us-east-1").trim() || "us-east-1",
  }
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

function encodeObjectKeyPath(objectKey: string): string {
  return objectKey
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = ""
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0")
  }
  return hex
}

function toArrayBuffer(value: ArrayBuffer | Uint8Array | string): ArrayBuffer {
  if (typeof value === "string") {
    return encoder.encode(value).buffer.slice(0)
  }
  if (value instanceof Uint8Array) {
    const buffer = new ArrayBuffer(value.byteLength)
    new Uint8Array(buffer).set(value)
    return buffer
  }
  return value
}

export async function sha256Hex(value: ArrayBuffer | Uint8Array | string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(value))
  return bytesToHex(new Uint8Array(digest))
}

async function hmacSha256(
  key: ArrayBuffer | Uint8Array | string,
  value: string,
): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return await crypto.subtle.sign("HMAC", imported, encoder.encode(value))
}

async function buildSigningKey(secretKey: string, dateStamp: string, region: string): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(`AWS4${secretKey}`, dateStamp)
  const kRegion = await hmacSha256(kDate, region)
  const kService = await hmacSha256(kRegion, "s3")
  return await hmacSha256(kService, "aws4_request")
}

async function buildSignedRequest(input: {
  method: "GET" | "PUT"
  env: Env
  objectKey: string
  payloadHash: string
  headers?: Record<string, string>
  body?: ArrayBuffer
}): Promise<Request> {
  const config = resolveFilebaseConfig(input.env)
  const url = new URL(config.endpoint.toString())
  url.pathname = `/${encodeURIComponent(config.bucket)}/${encodeObjectKeyPath(input.objectKey)}`

  const now = new Date()
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "")
  const amzDate = `${iso.slice(0, 8)}T${iso.slice(9, 15)}Z`
  const dateStamp = amzDate.slice(0, 8)
  const host = url.host
  const canonicalHeaders = new Map<string, string>([
    ["host", host],
    ["x-amz-content-sha256", input.payloadHash],
    ["x-amz-date", amzDate],
  ])

  for (const [key, value] of Object.entries(input.headers ?? {})) {
    canonicalHeaders.set(key.toLowerCase(), value.trim())
  }

  const sortedEntries = [...canonicalHeaders.entries()].sort(([a], [b]) => a.localeCompare(b))
  const canonicalHeaderString = sortedEntries
    .map(([key, value]) => `${key}:${value}`)
    .join("\n")
  const signedHeaders = sortedEntries.map(([key]) => key).join(";")
  const canonicalRequest = [
    input.method,
    url.pathname,
    "",
    `${canonicalHeaderString}\n`,
    signedHeaders,
    input.payloadHash,
  ].join("\n")

  const scope = `${dateStamp}/${config.region}/s3/aws4_request`
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n")
  const signingKey = await buildSigningKey(config.secretKey, dateStamp, config.region)
  const signature = bytesToHex(new Uint8Array(await hmacSha256(signingKey, stringToSign)))
  const authorization = [
    "AWS4-HMAC-SHA256 Credential=",
    `${config.accessKey}/${scope}, `,
    `SignedHeaders=${signedHeaders}, `,
    `Signature=${signature}`,
  ].join("")

  const headers = new Headers()
  headers.set("authorization", authorization)
  headers.set("x-amz-content-sha256", input.payloadHash)
  headers.set("x-amz-date", amzDate)

  for (const [key, value] of sortedEntries) {
    if (key === "host" || key === "x-amz-content-sha256" || key === "x-amz-date") {
      continue
    }
    headers.set(key, value)
  }

  return new Request(url.toString(), {
    method: input.method,
    headers,
    body: input.body,
  })
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
  const request = await buildSignedRequest({
    method: "PUT",
    env: input.env,
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
  const request = await buildSignedRequest({
    method: "PUT",
    env: input.env,
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

  const config = resolveFilebaseConfig(input.env)
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
  const request = await buildSignedRequest({
    method: "GET",
    env: input.env,
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
