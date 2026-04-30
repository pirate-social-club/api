import { badRequestError, notFoundError, providerUnavailable } from "./errors"
import { makeId } from "./helpers"
import { sha256Hex } from "./crypto"
import { resolveFilebaseConfig } from "./storage/filebase-config"
import { buildS3SignedRequest, EMPTY_SHA256_HEX } from "./storage/s3-signing"
import type { Env } from "../env"

type UploadMediaInput<TKind extends string> = {
  env: Env
  file: File
  kind: TKind
  origin: string
  routePrefix: string
  objectKeyPrefix: string
  maxBytesByKind: Record<TKind, number>
}

type AssertMediaObjectInput<TKind extends string> = {
  kind: string
  objectName: string
  allowedKinds: readonly TKind[]
  objectKeyPrefix: string
  notFoundMessage: string
}

type FetchMediaInput = {
  env: Env
  objectKey: string
  notFoundMessage: string
}

const allowedMimeTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
])

function assertSupportedMimeType(kind: string, mimeType: string): void {
  if (!allowedMimeTypes.has(mimeType)) {
    throw badRequestError(`${kind} must be a JPEG, PNG, WebP, GIF, or AVIF image`)
  }
}

function inferMimeTypeFromFilename(filename: string): string | null {
  const normalized = filename.trim().toLowerCase()
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) {
    return "image/jpeg"
  }
  if (normalized.endsWith(".png")) {
    return "image/png"
  }
  if (normalized.endsWith(".webp")) {
    return "image/webp"
  }
  if (normalized.endsWith(".gif")) {
    return "image/gif"
  }
  if (normalized.endsWith(".avif")) {
    return "image/avif"
  }
  return null
}

function resolveImageMimeType(file: File): string {
  const declaredMimeType = file.type.trim().toLowerCase()
  if (allowedMimeTypes.has(declaredMimeType)) {
    return declaredMimeType
  }

  if (!declaredMimeType || declaredMimeType === "application/octet-stream") {
    return inferMimeTypeFromFilename(file.name) ?? declaredMimeType
  }

  return declaredMimeType
}

function assertFileSize(kind: string, sizeBytes: number, maxBytes: number): void {
  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    throw badRequestError(`${kind} upload is empty`)
  }

  if (sizeBytes > maxBytes) {
    throw badRequestError(`${kind} exceeds the ${Math.floor(maxBytes / (1024 * 1024))}MB limit`)
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
    case "image/avif":
      return "avif"
    default:
      throw badRequestError("Unsupported media type")
  }
}

function resolveObjectKey<TKind extends string>(
  objectKeyPrefix: string,
  kind: TKind,
  mimeType: string,
): { objectKey: string; objectName: string } {
  const objectName = `${makeId(kind)}.${extensionForMimeType(mimeType)}`
  return {
    objectKey: `${objectKeyPrefix}/${kind}/${objectName}`,
    objectName,
  }
}

function buildGatewayMediaRef(env: Env, cid: string): string {
  const gateway = String(env.IPFS_GATEWAY_URL || "https://psc.myfilebase.com/ipfs").trim()
  const normalizedGateway = gateway.replace(/\/+$/, "")
  return `${normalizedGateway}/${encodeURIComponent(cid)}`
}

function requireFilebaseCid(response: Response): string {
  const cid = response.headers.get("x-amz-meta-cid")?.trim()
  if (!cid) {
    throw providerUnavailable("Filebase upload did not return an IPFS CID")
  }
  return cid
}

export async function uploadMedia<TKind extends string>(input: UploadMediaInput<TKind>): Promise<{
  kind: TKind
  media_ref: string
  ipfs_cid: string
  mime_type: string
  size_bytes: number
  storage_bucket: string
  storage_object_key: string
}> {
  const mimeType = resolveImageMimeType(input.file)
  assertSupportedMimeType(input.kind, mimeType)
  assertFileSize(input.kind, input.file.size, input.maxBytesByKind[input.kind])

  const fileBytes = await input.file.arrayBuffer()
  const payloadHash = await sha256Hex(fileBytes)
  const { objectKey } = resolveObjectKey(input.objectKeyPrefix, input.kind, mimeType)
  const request = await buildS3SignedRequest({
    method: "PUT",
    config: resolveFilebaseConfig(input.env, "media"),
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
  const ipfsCid = requireFilebaseCid(response)

  return {
    kind: input.kind,
    media_ref: buildGatewayMediaRef(input.env, ipfsCid),
    ipfs_cid: ipfsCid,
    mime_type: mimeType,
    size_bytes: input.file.size,
    storage_bucket: resolveFilebaseConfig(input.env, "media").bucket,
    storage_object_key: objectKey,
  }
}

export function assertMediaObject<TKind extends string>(input: AssertMediaObjectInput<TKind>): {
  kind: TKind
  objectKey: string
} {
  const kind = input.allowedKinds.find((candidate) => candidate === input.kind) ?? null
  if (!kind) {
    throw notFoundError(input.notFoundMessage)
  }

  const objectName = input.objectName.trim()
  if (!/^[A-Za-z0-9_.-]+$/.test(objectName)) {
    throw notFoundError(input.notFoundMessage)
  }

  return {
    kind,
    objectKey: `${input.objectKeyPrefix}/${kind}/${objectName}`,
  }
}

export async function fetchMedia(input: FetchMediaInput): Promise<Response> {
  const request = await buildS3SignedRequest({
    method: "GET",
    config: resolveFilebaseConfig(input.env, "media"),
    objectKey: input.objectKey,
    payloadHash: EMPTY_SHA256_HEX,
  })
  const upstream = await fetch(request)

  if (upstream.status === 404) {
    throw notFoundError(input.notFoundMessage)
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

  // Filebase response streams can stall when passed through the Worker directly.
  // Profile/community media is size-limited, so buffer it before responding.
  const body = await upstream.arrayBuffer()

  return new Response(body, {
    status: 200,
    headers,
  })
}
