import { badRequestError, internalError, notFoundError, providerUnavailable } from "../errors"
import { makeId } from "../helpers"
import type { Env } from "../../types"

export type ProfileMediaKind = "avatar" | "cover"

type ResolvedFilebaseConfig = {
  accessKey: string
  secretKey: string
  bucket: string
  endpoint: URL
  region: string
}

const encoder = new TextEncoder()
const EMPTY_SHA256_HEX = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
const allowedMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
])
const maxBytesByKind: Record<ProfileMediaKind, number> = {
  avatar: 5 * 1024 * 1024,
  cover: 12 * 1024 * 1024,
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
      env.FILEBASE_MEDIA_BUCKET || env.FILEBASE_S3_BUCKET_MUSIC,
      "FILEBASE_MEDIA_BUCKET is not configured",
    ),
    endpoint: new URL(endpointValue),
    region: String(env.FILEBASE_S3_REGION || "us-east-1").trim() || "us-east-1",
  }
}

function assertSupportedMimeType(kind: ProfileMediaKind, mimeType: string): void {
  if (!allowedMimeTypes.has(mimeType)) {
    throw badRequestError(`${kind} must be a JPEG, PNG, WebP, or GIF image`)
  }
}

function assertFileSize(kind: ProfileMediaKind, sizeBytes: number): void {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw badRequestError(`${kind} upload is empty`)
  }

  if (sizeBytes > maxBytesByKind[kind]) {
    throw badRequestError(`${kind} exceeds the ${Math.floor(maxBytesByKind[kind] / (1024 * 1024))}MB limit`)
  }
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg"
    case "image/png":
      return "png"
    case "image/webp":
      return "webp"
    case "image/gif":
      return "gif"
    default:
      throw badRequestError("Unsupported media type")
  }
}

function resolveObjectKey(kind: ProfileMediaKind, mimeType: string): { objectKey: string; objectName: string } {
  const objectName = `${makeId(kind)}.${extensionForMimeType(mimeType)}`
  return {
    objectKey: `profile-media/${kind}/${objectName}`,
    objectName,
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

async function sha256Hex(value: ArrayBuffer | Uint8Array | string): Promise<string> {
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

function buildMediaRef(origin: string, kind: ProfileMediaKind, objectName: string): string {
  return new URL(`/profile-media/${kind}/${objectName}`, origin).toString()
}

export async function uploadProfileMedia(input: {
  env: Env
  file: File
  kind: ProfileMediaKind
  origin: string
}): Promise<{
  kind: ProfileMediaKind
  media_ref: string
  mime_type: string
  size_bytes: number
  storage_bucket: string
  storage_object_key: string
}> {
  const mimeType = input.file.type.trim().toLowerCase()
  assertSupportedMimeType(input.kind, mimeType)
  assertFileSize(input.kind, input.file.size)

  const fileBytes = await input.file.arrayBuffer()
  const payloadHash = await sha256Hex(fileBytes)
  const { objectKey, objectName } = resolveObjectKey(input.kind, mimeType)
  const request = await buildSignedRequest({
    method: "PUT",
    env: input.env,
    objectKey,
    payloadHash,
    headers: {
      "content-type": mimeType,
    },
    body: fileBytes,
  })
  const response = await fetch(request)
  if (!response.ok) {
    const responseText = await response.text().catch(() => "")
    throw providerUnavailable(
      `Filebase upload failed with status ${response.status}${responseText ? `: ${responseText}` : ""}`,
    )
  }

  return {
    kind: input.kind,
    media_ref: buildMediaRef(input.origin, input.kind, objectName),
    mime_type: mimeType,
    size_bytes: input.file.size,
    storage_bucket: resolveFilebaseConfig(input.env).bucket,
    storage_object_key: objectKey,
  }
}

export function assertProfileMediaObject(input: {
  kind: string
  objectName: string
}): { kind: ProfileMediaKind; objectKey: string } {
  const kind = input.kind === "avatar" || input.kind === "cover"
    ? input.kind
    : null
  if (!kind) {
    throw notFoundError("Profile media not found")
  }

  const objectName = input.objectName.trim()
  if (!/^[A-Za-z0-9_.-]+$/.test(objectName)) {
    throw notFoundError("Profile media not found")
  }

  return {
    kind,
    objectKey: `profile-media/${kind}/${objectName}`,
  }
}

export async function fetchProfileMedia(input: {
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
    throw notFoundError("Profile media not found")
  }

  if (!upstream.ok) {
    const responseText = await upstream.text().catch(() => "")
    throw providerUnavailable(
      `Filebase media fetch failed with status ${upstream.status}${responseText ? `: ${responseText}` : ""}`,
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
