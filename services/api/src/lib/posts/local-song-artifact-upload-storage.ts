import { createHash, createHmac } from "node:crypto"
import { access, mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { internalError } from "../errors"
import type { Env } from "../../types"

const DEFAULT_FILEBASE_S3_ENDPOINT = "https://s3.filebase.com"
const DEFAULT_FILEBASE_S3_REGION = "us-east-1"
const DEFAULT_IPFS_GATEWAY_URL = "https://psc.myfilebase.com/ipfs"

function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "")
}

function encodeQueryComponent(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("")
}

function sha256Hex(data: string | Uint8Array): string {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data
  return createHash("sha256").update(bytes).digest("hex")
}

function hmacSha256(key: Uint8Array | string, data: string): Uint8Array {
  const hmac = createHmac("sha256", key)
  hmac.update(data)
  return new Uint8Array(hmac.digest())
}

function formatAmzDate(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "")
  return {
    amzDate: iso,
    dateStamp: iso.slice(0, 8),
  }
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

function encodePath(path: string): string {
  return path
    .split("/")
    .map((segment) => encodeRfc3986(segment))
    .join("/")
}

function firstHeaderValue(headers: Headers, keys: string[]): string | null {
  for (const key of keys) {
    const value = headers.get(key)
    if (value && value.trim()) {
      return value.trim()
    }
  }
  return null
}

function artifactDirectory(artifactKind: string | null | undefined): string {
  switch (String(artifactKind || "").trim()) {
    case "primary_audio":
      return "song-artifacts/primary"
    case "preview_audio":
      return "song-artifacts/previews"
    case "cover_art":
      return "song-artifacts/covers"
    case "canvas_video":
      return "song-artifacts/canvas"
    case "locked_payload":
      return "song-artifacts/locked"
    case "instrumental_audio":
      return "song-artifacts/instrumentals"
    case "vocal_audio":
      return "song-artifacts/vocals"
    default:
      return "song-artifacts/misc"
  }
}

function extensionForMimeType(mimeType: string | null | undefined): string {
  const normalized = String(mimeType || "").trim().toLowerCase()
  switch (normalized) {
    case "audio/mpeg":
      return "mp3"
    case "audio/wav":
    case "audio/x-wav":
      return "wav"
    case "audio/mp4":
      return "m4a"
    case "audio/ogg":
      return "ogg"
    case "audio/flac":
      return "flac"
    case "image/png":
      return "png"
    case "image/jpeg":
      return "jpg"
    case "image/webp":
      return "webp"
    case "video/mp4":
      return "mp4"
    case "video/webm":
      return "webm"
    default:
      return "bin"
  }
}

function artifactObjectKey(input: {
  artifactKind?: string | null
  uploadId: string
  mimeType?: string | null
}): string {
  return `${artifactDirectory(input.artifactKind)}/${input.uploadId}.${extensionForMimeType(input.mimeType)}`
}

const LOCAL_ARTIFACT_DIRECTORIES = [
  "song-artifacts/primary",
  "song-artifacts/previews",
  "song-artifacts/covers",
  "song-artifacts/canvas",
  "song-artifacts/locked",
  "song-artifacts/instrumentals",
  "song-artifacts/vocals",
  "song-artifacts/misc",
] as const

const LOCAL_ARTIFACT_EXTENSIONS = [
  "bin",
  "mp3",
  "wav",
  "m4a",
  "ogg",
  "flac",
  "png",
  "jpg",
  "webp",
  "mp4",
  "webm",
] as const

async function persistFilebaseSongArtifactUpload(input: {
  env: Env
  uploadId: string
  bytes: Uint8Array
  contentHash: string
  artifactKind?: string | null
  mimeType?: string | null
}): Promise<{
  storageRef: string
  blobPath: string
  sizeBytes: number
  contentHash: string
  storageProvider: "filebase"
  storageBucket: string
  storageObjectKey: string
  storageEndpoint: string
  gatewayUrl: string
}> {
  const accessKey = String(input.env.FILEBASE_S3_ACCESS_KEY || "").trim()
  const secretKey = String(input.env.FILEBASE_S3_SECRET_KEY || "").trim()
  const bucket = String(input.env.FILEBASE_S3_BUCKET_MUSIC || "").trim()
  if (!accessKey || !secretKey || !bucket) {
    throw internalError("Filebase music upload is not configured")
  }

  const endpoint = new URL(normalizeBaseUrl(input.env.FILEBASE_S3_ENDPOINT || DEFAULT_FILEBASE_S3_ENDPOINT))
  const region = String(input.env.FILEBASE_S3_REGION || DEFAULT_FILEBASE_S3_REGION).trim() || DEFAULT_FILEBASE_S3_REGION
  const gatewayBase = normalizeBaseUrl(input.env.IPFS_GATEWAY_URL || DEFAULT_IPFS_GATEWAY_URL)
  const objectKey = artifactObjectKey(input)
  const requestPath = `${endpoint.pathname.replace(/\/+$/, "")}/${encodePath(bucket)}/${encodePath(objectKey)}`.replace(/\/+/g, "/")
  const requestUrl = `${endpoint.origin}${requestPath}`
  const contentType = String(input.mimeType || "").trim() || "application/octet-stream"
  const { amzDate, dateStamp } = formatAmzDate(new Date())
  const canonicalHeaders = [
    `content-type:${contentType}`,
    `host:${endpoint.host}`,
    `x-amz-content-sha256:${input.contentHash.replace(/^sha256:/, "")}`,
    `x-amz-date:${amzDate}`,
  ].join("\n") + "\n"
  const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date"
  const canonicalRequest = [
    "PUT",
    requestPath,
    "",
    canonicalHeaders,
    signedHeaders,
    input.contentHash.replace(/^sha256:/, ""),
  ].join("\n")
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n")
  const kDate = hmacSha256(`AWS4${secretKey}`, dateStamp)
  const kRegion = hmacSha256(kDate, region)
  const kService = hmacSha256(kRegion, "s3")
  const kSigning = hmacSha256(kService, "aws4_request")
  const signature = bytesToHex(hmacSha256(kSigning, stringToSign))
  const authorization = [
    `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ")

  const response = await fetch(requestUrl, {
    method: "PUT",
    headers: {
      Authorization: authorization,
      "Content-Type": contentType,
      "X-Amz-Date": amzDate,
      "X-Amz-Content-Sha256": input.contentHash.replace(/^sha256:/, ""),
    },
    body: new Blob([Uint8Array.from(input.bytes)], { type: contentType }),
  })
  if (!response.ok) {
    const errorBody = await response.text().catch(() => "")
    throw internalError(`Filebase upload failed: ${response.status} ${errorBody.slice(0, 300)}`)
  }

  const cid = firstHeaderValue(response.headers, ["x-amz-meta-cid", "x-filebase-cid"])
  if (!cid) {
    throw internalError("Filebase upload succeeded without a CID header")
  }

  return {
    storageRef: `ipfs://${cid}`,
    blobPath: `filebase://${bucket}/${objectKey}`,
    sizeBytes: input.bytes.byteLength,
    contentHash: input.contentHash,
    storageProvider: "filebase",
    storageBucket: bucket,
    storageObjectKey: objectKey,
    storageEndpoint: endpoint.origin,
    gatewayUrl: `${gatewayBase}/${cid}`,
  }
}

export async function persistSongArtifactUpload(input: {
  env: Env
  uploadId: string
  bytes: Uint8Array
  artifactKind?: string | null
  mimeType?: string | null
}): Promise<{
  storageRef: string
  blobPath: string
  sizeBytes: number
  contentHash: string
  storageProvider: "filebase" | "local_stub"
  storageBucket: string | null
  storageObjectKey: string | null
  storageEndpoint: string | null
  gatewayUrl: string | null
}> {
  const contentHash = `sha256:${createHash("sha256").update(input.bytes).digest("hex")}`
  if (
    String(input.env.FILEBASE_S3_ACCESS_KEY || "").trim()
    && String(input.env.FILEBASE_S3_SECRET_KEY || "").trim()
    && String(input.env.FILEBASE_S3_BUCKET_MUSIC || "").trim()
  ) {
    return persistFilebaseSongArtifactUpload({
      env: input.env,
      uploadId: input.uploadId,
      bytes: input.bytes,
      contentHash,
      artifactKind: input.artifactKind,
      mimeType: input.mimeType,
    })
  }

  const configuredRoot = String(input.env.LOCAL_COMMUNITY_DB_ROOT || "").trim()
  if (!configuredRoot) {
    throw internalError("LOCAL_COMMUNITY_DB_ROOT is not configured")
  }

  const uploadRoot = join(configuredRoot, "_song_uploads", artifactDirectory(input.artifactKind))
  await mkdir(uploadRoot, { recursive: true })
  const blobPath = join(uploadRoot, `${input.uploadId}.${extensionForMimeType(input.mimeType)}`)
  await writeFile(blobPath, input.bytes)

  return {
    storageRef: `ipfs://local-song-artifact-upload/${input.uploadId}`,
    blobPath,
    sizeBytes: input.bytes.byteLength,
    contentHash,
    storageProvider: "local_stub",
    storageBucket: null,
    storageObjectKey: null,
    storageEndpoint: null,
    gatewayUrl: null,
  }
}

export function createSignedSongArtifactDownloadUrl(input: {
  env: Env
  uploadId: string
  artifactKind?: string | null
  mimeType?: string | null
  expiresInSeconds?: number
}): string | null {
  const accessKey = String(input.env.FILEBASE_S3_ACCESS_KEY || "").trim()
  const secretKey = String(input.env.FILEBASE_S3_SECRET_KEY || "").trim()
  const bucket = String(input.env.FILEBASE_S3_BUCKET_MUSIC || "").trim()
  if (!accessKey || !secretKey || !bucket) {
    return null
  }

  const endpoint = new URL(normalizeBaseUrl(input.env.FILEBASE_S3_ENDPOINT || DEFAULT_FILEBASE_S3_ENDPOINT))
  const region = String(input.env.FILEBASE_S3_REGION || DEFAULT_FILEBASE_S3_REGION).trim() || DEFAULT_FILEBASE_S3_REGION
  const objectKey = artifactObjectKey(input)
  const requestPath = `${endpoint.pathname.replace(/\/+$/, "")}/${encodePath(bucket)}/${encodePath(objectKey)}`.replace(/\/+/g, "/")
  const { amzDate, dateStamp } = formatAmzDate(new Date())
  const expiresIn = Math.max(60, Math.min(3600, input.expiresInSeconds ?? 900))
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`
  const canonicalQuery = [
    `X-Amz-Algorithm=${encodeQueryComponent("AWS4-HMAC-SHA256")}`,
    `X-Amz-Credential=${encodeQueryComponent(`${accessKey}/${credentialScope}`)}`,
    `X-Amz-Date=${encodeQueryComponent(amzDate)}`,
    `X-Amz-Expires=${encodeQueryComponent(String(expiresIn))}`,
    `X-Amz-SignedHeaders=${encodeQueryComponent("host")}`,
  ].join("&")
  const canonicalRequest = [
    "GET",
    requestPath,
    canonicalQuery,
    `host:${endpoint.host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n")
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n")
  const kDate = hmacSha256(`AWS4${secretKey}`, dateStamp)
  const kRegion = hmacSha256(kDate, region)
  const kService = hmacSha256(kRegion, "s3")
  const kSigning = hmacSha256(kService, "aws4_request")
  const signature = bytesToHex(hmacSha256(kSigning, stringToSign))
  return `${endpoint.origin}${requestPath}?${canonicalQuery}&X-Amz-Signature=${signature}`
}

export async function resolveLocalSongArtifactUploadPath(input: {
  env: Env
  uploadId: string
}): Promise<string> {
  const configuredRoot = String(input.env.LOCAL_COMMUNITY_DB_ROOT || "").trim()
  if (!configuredRoot || !input.uploadId.trim()) {
    throw internalError("LOCAL_COMMUNITY_DB_ROOT is not configured")
  }

  const uploadRoot = join(configuredRoot, "_song_uploads")
  for (const directory of LOCAL_ARTIFACT_DIRECTORIES) {
    for (const extension of LOCAL_ARTIFACT_EXTENSIONS) {
      const candidate = join(uploadRoot, directory, `${input.uploadId}.${extension}`)
      try {
        await access(candidate)
        return candidate
      } catch {}
    }
  }

  throw internalError(`Local song artifact upload not found for ${input.uploadId}`)
}
