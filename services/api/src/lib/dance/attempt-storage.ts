import { internalError, providerUnavailable } from "../errors"
import { buildS3PresignedUrl, buildS3SignedRequest } from "../storage/s3-signing"
import type { Env } from "../../env"
import type { S3SigningConfig } from "../storage/s3-signing"

const SHA256 = /^[0-9a-f]{64}$/
const SESSION_ID = /^[a-zA-Z0-9_-]{1,100}$/
const MAX_ATTEMPT_BYTES = 64 * 1024 * 1024

function required(value: string | undefined, name: string): string {
  const normalized = String(value ?? "").trim()
  if (!normalized) throw internalError(`${name} is not configured`)
  return normalized
}

export function resolveDanceAttemptStorageConfig(env: Env): S3SigningConfig {
  const endpoint = new URL(required(env.DANCE_ATTEMPT_S3_ENDPOINT, "DANCE_ATTEMPT_S3_ENDPOINT"))
  if (endpoint.protocol !== "https:") {
    throw internalError("DANCE_ATTEMPT_S3_ENDPOINT must use HTTPS")
  }
  return {
    endpoint,
    accessKey: required(env.DANCE_ATTEMPT_S3_ACCESS_KEY, "DANCE_ATTEMPT_S3_ACCESS_KEY"),
    secretKey: required(env.DANCE_ATTEMPT_S3_SECRET_KEY, "DANCE_ATTEMPT_S3_SECRET_KEY"),
    bucket: required(env.DANCE_ATTEMPT_S3_BUCKET, "DANCE_ATTEMPT_S3_BUCKET"),
    region: String(env.DANCE_ATTEMPT_S3_REGION ?? "auto").trim() || "auto",
  }
}

export function danceAttemptObjectKey(sessionId: string, contentSha256: string): string {
  if (!SESSION_ID.test(sessionId)) throw internalError("Dance attempt session id is invalid")
  if (!SHA256.test(contentSha256)) throw internalError("Dance attempt content hash is invalid")
  return `dance/attempt-media/${sessionId}/${contentSha256}.mp4`
}

export async function buildDanceAttemptUploadIntent(input: {
  env: Env
  sessionId: string
  contentSha256: string
  sizeBytes: number
  now: Date
  expiresInSeconds?: number
}): Promise<{
  objectKey: string
  putUrl: string
  requiredHeaders: Record<string, string>
}> {
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > MAX_ATTEMPT_BYTES) {
    throw internalError("Dance attempt size is invalid")
  }
  const objectKey = danceAttemptObjectKey(input.sessionId, input.contentSha256)
  const requiredHeaders = {
    "content-length": String(input.sizeBytes),
    "content-type": "video/mp4",
    "x-amz-meta-content-sha256": input.contentSha256,
  }
  const putUrl = await buildS3PresignedUrl({
    method: "PUT",
    config: resolveDanceAttemptStorageConfig(input.env),
    objectKey,
    headers: requiredHeaders,
    bodyHashMode: "unsigned",
    expiresInSeconds: input.expiresInSeconds ?? 300,
    now: input.now,
  })
  return { objectKey, putUrl: putUrl.toString(), requiredHeaders }
}

export async function verifyDanceAttemptUpload(input: {
  env: Env
  objectKey: string
  expectedContentSha256: string
  expectedSizeBytes: number
  fetchFn?: typeof fetch
  now?: Date
}): Promise<{ etag: string }> {
  const request = await buildS3SignedRequest({
    method: "HEAD",
    config: resolveDanceAttemptStorageConfig(input.env),
    objectKey: input.objectKey,
    bodyHashMode: "empty",
    now: input.now,
  })
  const response = await (input.fetchFn ?? fetch)(request)
  if (!response.ok) throw providerUnavailable(`Dance attempt upload HEAD failed (${response.status})`)
  const sizeBytes = Number(response.headers.get("content-length"))
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
  const contentSha256 = response.headers.get("x-amz-meta-content-sha256")?.trim().toLowerCase()
  const etag = response.headers.get("etag")?.trim()
  if (
    sizeBytes !== input.expectedSizeBytes
    || contentType !== "video/mp4"
    || contentSha256 !== input.expectedContentSha256
    || !etag
  ) {
    throw providerUnavailable("Dance attempt upload metadata does not match its intent")
  }
  return { etag }
}
