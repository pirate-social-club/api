import { bytesToHex, sha256Hex, toArrayBuffer } from "../crypto"

export const EMPTY_SHA256_HEX = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

const encoder = new TextEncoder()

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
  method: "GET" | "PUT"
  config: S3SigningConfig
  objectKey: string
  payloadHash: string
  headers?: Record<string, string>
  body?: ArrayBuffer
}): Promise<Request> {
  const url = new URL(input.config.endpoint.toString())
  url.pathname = `/${encodeURIComponent(input.config.bucket)}/${encodeObjectKeyPath(input.objectKey)}`

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
