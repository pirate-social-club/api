import { bytesToHex, sha256Hex, toArrayBuffer } from "../crypto"

export const EMPTY_SHA256_HEX = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
export const S3_UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD"

const encoder = new TextEncoder()

export type S3HttpMethod = "GET" | "HEAD" | "PUT" | "POST" | "DELETE"
export type S3BodyHashMode = "empty" | "single_chunk" | "unsigned"

export type S3SigningConfig = {
  accessKey: string
  secretKey: string
  bucket: string
  endpoint: URL
  region: string
}

function encodeObjectKeyPath(objectKey: string): string {
  return objectKey
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")
}

function buildS3Url(input: {
  config: S3SigningConfig
  objectKey: string
  query?: Record<string, string>
}): URL {
  const url = new URL(input.config.endpoint.toString())
  url.pathname = `/${encodeURIComponent(input.config.bucket)}/${encodeObjectKeyPath(input.objectKey)}`
  for (const [key, value] of Object.entries(input.query ?? {})) {
    url.searchParams.set(key, value)
  }
  return url
}

function formatAmzDate(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, "")
  const amzDate = `${iso.slice(0, 8)}T${iso.slice(9, 15)}Z`
  return {
    amzDate,
    dateStamp: amzDate.slice(0, 8),
  }
}

function canonicalQueryString(query: Record<string, string> | undefined): string {
  return Object.entries(query ?? {})
    .map(([key, value]) => [encodeURIComponent(key), encodeURIComponent(value)] as const)
    .sort(([aKey, aValue], [bKey, bValue]) => compareCanonical(aKey, bKey) || compareCanonical(aValue, bValue))
    .map(([key, value]) => `${key}=${value}`)
    .join("&")
}

function compareCanonical(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function buildCanonicalHeaderEntries(input: {
  host: string
  amzDate?: string
  payloadHash?: string
  headers?: Record<string, string>
}): Array<[string, string]> {
  const canonicalHeaders = new Map<string, string>([
    ["host", input.host],
  ])
  if (input.payloadHash) {
    canonicalHeaders.set("x-amz-content-sha256", input.payloadHash)
  }
  if (input.amzDate) {
    canonicalHeaders.set("x-amz-date", input.amzDate)
  }

  for (const [key, value] of Object.entries(input.headers ?? {})) {
    canonicalHeaders.set(key.toLowerCase(), value.trim())
  }

  return [...canonicalHeaders.entries()].sort(([a], [b]) => compareCanonical(a, b))
}

function buildCanonicalHeaderString(entries: Array<[string, string]>): string {
  return entries
    .map(([key, value]) => `${key}:${value}`)
    .join("\n")
}

function signedHeaders(entries: Array<[string, string]>): string {
  return entries.map(([key]) => key).join(";")
}

function normalizePayloadHash(payloadHash: string): string {
  const trimmed = payloadHash.trim()
  return trimmed === S3_UNSIGNED_PAYLOAD ? trimmed : trimmed.replace(/^0x/i, "").toLowerCase()
}

async function resolvePayloadHash(input: {
  payloadHash?: string
  bodyHashMode?: S3BodyHashMode
  body?: ArrayBuffer | Uint8Array | string
}): Promise<string> {
  if (input.bodyHashMode === "unsigned") {
    return S3_UNSIGNED_PAYLOAD
  }
  if (input.payloadHash) {
    return normalizePayloadHash(input.payloadHash)
  }
  if (input.bodyHashMode === "empty") {
    return EMPTY_SHA256_HEX
  }
  return await sha256Hex(input.body ?? "")
}

function requestBody(body: ArrayBuffer | Uint8Array | string | undefined): BodyInit | undefined {
  if (body == null) {
    return undefined
  }
  if (typeof body === "string") {
    return body
  }
  return body instanceof Uint8Array ? toArrayBuffer(body) : body
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

export async function buildS3SignedRequest(input: {
  method: S3HttpMethod
  config: S3SigningConfig
  objectKey: string
  query?: Record<string, string>
  payloadHash?: string
  bodyHashMode?: S3BodyHashMode
  headers?: Record<string, string>
  body?: ArrayBuffer | Uint8Array | string
  now?: Date
}): Promise<Request> {
  const url = buildS3Url(input)
  const payloadHash = await resolvePayloadHash(input)
  const { amzDate, dateStamp } = formatAmzDate(input.now ?? new Date())
  const host = url.host
  const sortedEntries = buildCanonicalHeaderEntries({
    host,
    amzDate,
    payloadHash,
    headers: input.headers,
  })
  const canonicalHeaderString = buildCanonicalHeaderString(sortedEntries)
  const signedHeaderString = signedHeaders(sortedEntries)
  const canonicalRequest = [
    input.method,
    url.pathname,
    canonicalQueryString(input.query),
    `${canonicalHeaderString}\n`,
    signedHeaderString,
    payloadHash,
  ].join("\n")

  const scope = `${dateStamp}/${input.config.region}/s3/aws4_request`
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n")
  const signingKey = await buildSigningKey(input.config.secretKey, dateStamp, input.config.region)
  const signature = bytesToHex(new Uint8Array(await hmacSha256(signingKey, stringToSign)))
  const authorization = [
    "AWS4-HMAC-SHA256 Credential=",
    `${input.config.accessKey}/${scope}, `,
    `SignedHeaders=${signedHeaderString}, `,
    `Signature=${signature}`,
  ].join("")

  const headers = new Headers()
  headers.set("authorization", authorization)
  headers.set("x-amz-content-sha256", payloadHash)
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
    body: requestBody(input.body),
  })
}

export async function buildS3PresignedUrl(input: {
  method: S3HttpMethod
  config: S3SigningConfig
  objectKey: string
  query?: Record<string, string>
  headers?: Record<string, string>
  payloadHash?: string
  bodyHashMode?: S3BodyHashMode
  expiresInSeconds?: number
  now?: Date
}): Promise<URL> {
  const expiresInSeconds = input.expiresInSeconds ?? 300
  if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 604800) {
    throw new Error("S3 presigned URL expiry must be between 1 and 604800 seconds")
  }
  const url = buildS3Url(input)
  const payloadHash = await resolvePayloadHash(input)
  const { amzDate, dateStamp } = formatAmzDate(input.now ?? new Date())
  const scope = `${dateStamp}/${input.config.region}/s3/aws4_request`
  const sortedEntries = buildCanonicalHeaderEntries({
    host: url.host,
    headers: input.headers,
  })
  const signedHeaderString = signedHeaders(sortedEntries)
  const signingQuery = {
    ...(input.query ?? {}),
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${input.config.accessKey}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresInSeconds),
    "X-Amz-SignedHeaders": signedHeaderString,
  }
  const canonicalRequest = [
    input.method,
    url.pathname,
    canonicalQueryString(signingQuery),
    `${buildCanonicalHeaderString(sortedEntries)}\n`,
    signedHeaderString,
    payloadHash,
  ].join("\n")
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n")
  const signingKey = await buildSigningKey(input.config.secretKey, dateStamp, input.config.region)
  const signature = bytesToHex(new Uint8Array(await hmacSha256(signingKey, stringToSign)))

  for (const [key, value] of Object.entries(signingQuery)) {
    url.searchParams.set(key, value)
  }
  url.searchParams.set("X-Amz-Signature", signature)
  return url
}
