export {}

const encoder = new TextEncoder()

type S3Config = {
  accessKey: string
  secretKey: string
  bucket: string
  endpoint: URL
  region: string
}

type SignedRequestInput = {
  config: S3Config
  method: string
  objectKey?: string
  query?: Record<string, string>
  headers?: Record<string, string>
  body?: ArrayBuffer | Uint8Array | string
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`${name} is required`)
  }
  return value
}

function readConfig(): S3Config {
  return {
    accessKey: requireEnv("FILEBASE_S3_ACCESS_KEY"),
    secretKey: requireEnv("FILEBASE_S3_SECRET_KEY"),
    bucket: requireEnv("FILEBASE_MEDIA_BUCKET"),
    endpoint: new URL(process.env.FILEBASE_S3_ENDPOINT?.trim() || "https://s3.filebase.com"),
    region: process.env.FILEBASE_S3_REGION?.trim() || "us-east-1",
  }
}

function toBytes(value: ArrayBuffer | Uint8Array | string | undefined): Uint8Array {
  if (value == null) {
    return new Uint8Array()
  }
  if (typeof value === "string") {
    return encoder.encode(value)
  }
  if (value instanceof Uint8Array) {
    return value
  }
  return new Uint8Array(value)
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(value.byteLength)
  new Uint8Array(buffer).set(value)
  return buffer
}

async function sha256Hex(value: ArrayBuffer | Uint8Array | string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toArrayBuffer(toBytes(value)))
  return bytesToHex(new Uint8Array(digest))
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function hmacSha256(key: ArrayBuffer | Uint8Array | string, value: string): Promise<ArrayBuffer> {
  const imported = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(toBytes(key)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  return await crypto.subtle.sign("HMAC", imported, encoder.encode(value))
}

async function signingKey(config: S3Config, dateStamp: string): Promise<ArrayBuffer> {
  const kDate = await hmacSha256(`AWS4${config.secretKey}`, dateStamp)
  const kRegion = await hmacSha256(kDate, config.region)
  const kService = await hmacSha256(kRegion, "s3")
  return await hmacSha256(kService, "aws4_request")
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value)
}

function encodeObjectKeyPath(objectKey: string): string {
  return objectKey.split("/").map(encodePathSegment).join("/")
}

function canonicalQuery(query: Record<string, string> | undefined): string {
  return Object.entries(query ?? {})
    .map(([key, value]) => [encodeURIComponent(key), encodeURIComponent(value)] as const)
    .sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue))
    .map(([key, value]) => `${key}=${value}`)
    .join("&")
}

function buildUrl(input: SignedRequestInput): URL {
  const url = new URL(input.config.endpoint.toString())
  const objectPath = input.objectKey ? `/${encodeObjectKeyPath(input.objectKey)}` : ""
  url.pathname = `/${encodeURIComponent(input.config.bucket)}${objectPath}`
  for (const [key, value] of Object.entries(input.query ?? {})) {
    url.searchParams.set(key, value)
  }
  return url
}

async function buildSignedRequest(input: SignedRequestInput): Promise<Request> {
  const url = buildUrl(input)
  const bodyBytes = toBytes(input.body)
  const payloadHash = await sha256Hex(bodyBytes)
  const iso = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "")
  const amzDate = `${iso.slice(0, 8)}T${iso.slice(9, 15)}Z`
  const dateStamp = amzDate.slice(0, 8)
  const headers = new Map<string, string>([
    ["host", url.host],
    ["x-amz-content-sha256", payloadHash],
    ["x-amz-date", amzDate],
  ])
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    headers.set(key.toLowerCase(), value.trim())
  }

  const sortedHeaders = [...headers.entries()].sort(([a], [b]) => a.localeCompare(b))
  const signedHeaders = sortedHeaders.map(([key]) => key).join(";")
  const canonicalHeaders = sortedHeaders.map(([key, value]) => `${key}:${value}`).join("\n")
  const canonicalRequest = [
    input.method,
    url.pathname,
    canonicalQuery(input.query),
    `${canonicalHeaders}\n`,
    signedHeaders,
    payloadHash,
  ].join("\n")
  const scope = `${dateStamp}/${input.config.region}/s3/aws4_request`
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n")
  const signature = bytesToHex(new Uint8Array(await hmacSha256(await signingKey(input.config, dateStamp), stringToSign)))
  const requestHeaders = new Headers()
  requestHeaders.set(
    "authorization",
    `AWS4-HMAC-SHA256 Credential=${input.config.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  )
  for (const [key, value] of sortedHeaders) {
    if (key === "host") {
      continue
    }
    requestHeaders.set(key, value)
  }

  return new Request(url, {
    method: input.method,
    headers: requestHeaders,
    body: bodyBytes.byteLength > 0 ? toArrayBuffer(bodyBytes) : undefined,
  })
}

function xmlValue(xml: string, tag: string): string | null {
  const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))
  return match?.[1]?.trim() || null
}

async function expectOk(response: Response, label: string): Promise<string> {
  const text = await response.text().catch(() => "")
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 500)}` : ""}`)
  }
  return text
}

function makePart(size: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(size)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = (index + seed) % 251
  }
  return bytes
}

function relevantHeaders(response: Response): Record<string, string | null> {
  return {
    etag: response.headers.get("etag"),
    contentType: response.headers.get("content-type"),
    contentLength: response.headers.get("content-length"),
    cid: response.headers.get("x-amz-meta-cid"),
    corsAllowOrigin: response.headers.get("access-control-allow-origin"),
    corsExposeHeaders: response.headers.get("access-control-expose-headers"),
  }
}

async function createMultipartUpload(config: S3Config, objectKey: string): Promise<string> {
  const request = await buildSignedRequest({
    config,
    method: "POST",
    objectKey,
    query: { uploads: "" },
    headers: { "content-type": "video/mp4" },
  })
  const xml = await expectOk(await fetch(request), "CreateMultipartUpload")
  const uploadId = xmlValue(xml, "UploadId")
  if (!uploadId) {
    throw new Error(`CreateMultipartUpload response did not include UploadId: ${xml.slice(0, 500)}`)
  }
  return uploadId
}

async function uploadPart(input: {
  config: S3Config
  objectKey: string
  uploadId: string
  partNumber: number
  bytes: Uint8Array
  corsOrigin?: string | null
}): Promise<{ etag: string; headers: Record<string, string | null> }> {
  const response = await fetch(await buildSignedRequest({
    config: input.config,
    method: "PUT",
    objectKey: input.objectKey,
    query: {
      partNumber: String(input.partNumber),
      uploadId: input.uploadId,
    },
    headers: {
      "content-type": "application/octet-stream",
      ...(input.corsOrigin ? { origin: input.corsOrigin } : {}),
    },
    body: input.bytes,
  }))
  await expectOk(response, `UploadPart ${input.partNumber}`)
  const etag = response.headers.get("etag")
  if (!etag) {
    throw new Error(`UploadPart ${input.partNumber} response did not include ETag`)
  }
  return { etag, headers: relevantHeaders(response) }
}

async function completeMultipartUpload(input: {
  config: S3Config
  objectKey: string
  uploadId: string
  parts: Array<{ partNumber: number; etag: string }>
}): Promise<Response> {
  const partsXml = input.parts
    .map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.etag}</ETag></Part>`)
    .join("")
  const body = `<CompleteMultipartUpload>${partsXml}</CompleteMultipartUpload>`
  const response = await fetch(await buildSignedRequest({
    config: input.config,
    method: "POST",
    objectKey: input.objectKey,
    query: { uploadId: input.uploadId },
    headers: { "content-type": "application/xml" },
    body,
  }))
  await expectOk(response.clone(), "CompleteMultipartUpload")
  return response
}

async function headObject(config: S3Config, objectKey: string): Promise<Response> {
  const response = await fetch(await buildSignedRequest({
    config,
    method: "HEAD",
    objectKey,
  }))
  await expectOk(response.clone(), "HeadObject")
  return response
}

async function abortMultipartUpload(config: S3Config, objectKey: string, uploadId: string): Promise<void> {
  const response = await fetch(await buildSignedRequest({
    config,
    method: "DELETE",
    objectKey,
    query: { uploadId },
  }))
  if (!response.ok && response.status !== 404) {
    console.warn("AbortMultipartUpload cleanup failed", response.status, await response.text().catch(() => ""))
  }
}

async function deleteObject(config: S3Config, objectKey: string): Promise<void> {
  const response = await fetch(await buildSignedRequest({
    config,
    method: "DELETE",
    objectKey,
  }))
  if (!response.ok && response.status !== 404) {
    console.warn("DeleteObject cleanup failed", response.status, await response.text().catch(() => ""))
  }
}

async function checkCors(config: S3Config, objectKey: string): Promise<Response> {
  const url = buildUrl({ config, method: "PUT", objectKey })
  return await fetch(url, {
    method: "OPTIONS",
    headers: {
      origin: process.env.FILEBASE_CORS_TEST_ORIGIN?.trim() || "https://pirate.sc",
      "access-control-request-method": "PUT",
      "access-control-request-headers": "content-type",
    },
  })
}

async function checkLifecycle(config: S3Config): Promise<Response> {
  return await fetch(await buildSignedRequest({
    config,
    method: "GET",
    query: { lifecycle: "" },
  }))
}

async function main(): Promise<void> {
  const config = readConfig()
  const objectKey = `spikes/filebase-multipart/${Date.now()}-${crypto.randomUUID()}.mp4`
  let uploadId: string | null = null
  let completed = false

  console.log("spike target", {
    endpoint: config.endpoint.origin,
    bucket: config.bucket,
    objectKey,
    region: config.region,
  })

  try {
    const corsResponse = await checkCors(config, objectKey)
    console.log("cors preflight", {
      status: corsResponse.status,
      ok: corsResponse.ok,
      headers: relevantHeaders(corsResponse),
      body: (await corsResponse.text().catch(() => "")).slice(0, 300),
    })

    const lifecycleResponse = await checkLifecycle(config)
    console.log("bucket lifecycle", {
      status: lifecycleResponse.status,
      ok: lifecycleResponse.ok,
      body: (await lifecycleResponse.text().catch(() => "")).slice(0, 500),
    })

    uploadId = await createMultipartUpload(config, objectKey)
    console.log("multipart initiated", { uploadIdPresent: Boolean(uploadId) })

    const part1 = makePart(5 * 1024 * 1024, 11)
    const part2 = makePart(1024 * 1024, 29)
    const corsOrigin = process.env.FILEBASE_CORS_TEST_ORIGIN?.trim() || "https://pirate.sc"
    const uploadedPart1 = await uploadPart({ config, objectKey, uploadId, partNumber: 1, bytes: part1, corsOrigin })
    const uploadedPart2 = await uploadPart({ config, objectKey, uploadId, partNumber: 2, bytes: part2, corsOrigin })
    console.log("parts uploaded", {
      partCount: 2,
      etagsPresent: [Boolean(uploadedPart1.etag), Boolean(uploadedPart2.etag)],
      firstPartHeaders: uploadedPart1.headers,
      sizes: [part1.byteLength, part2.byteLength],
    })

    const completeResponse = await completeMultipartUpload({
      config,
      objectKey,
      uploadId,
      parts: [
        { partNumber: 1, etag: uploadedPart1.etag },
        { partNumber: 2, etag: uploadedPart2.etag },
      ],
    })
    completed = true
    const completeXml = await completeResponse.text()
    const completeCid = xmlValue(completeXml, "CID")
    console.log("complete", {
      status: completeResponse.status,
      headers: relevantHeaders(completeResponse),
      cidFromXml: completeCid,
      xml: completeXml.slice(0, 500),
    })

    const headResponse = await headObject(config, objectKey)
    const headCid = headResponse.headers.get("x-amz-meta-cid")
    if (completeCid !== headCid) {
      throw new Error(`CID mismatch: complete=${completeCid || "missing"} head=${headCid || "missing"}`)
    }
    console.log("head", {
      status: headResponse.status,
      headers: relevantHeaders(headResponse),
      cidPresent: Boolean(headCid),
    })
  } finally {
    if (uploadId && !completed) {
      await abortMultipartUpload(config, objectKey, uploadId)
    }
    if (completed) {
      await deleteObject(config, objectKey)
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
