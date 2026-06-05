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
  query: Record<string, string>
  headers?: Record<string, string>
  body?: string
}

const defaultCorsOrigins = [
  "https://pirate.sc",
  "https://www.pirate.sc",
  "https://staging.pirate.sc",
  "http://localhost:5173",
]

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

function readCorsOrigins(): string[] {
  const value = process.env.FILEBASE_CORS_ALLOWED_ORIGINS?.trim()
  if (!value) {
    return defaultCorsOrigins
  }
  const origins = value.split(",").map((origin) => origin.trim()).filter(Boolean)
  if (!origins.length) {
    throw new Error("FILEBASE_CORS_ALLOWED_ORIGINS did not contain any origins")
  }
  return origins
}

function desiredCorsXml(origins: string[]): string {
  return [
    "<CORSConfiguration>",
    "  <CORSRule>",
    ...origins.map((origin) => `    <AllowedOrigin>${origin}</AllowedOrigin>`),
    "    <AllowedMethod>PUT</AllowedMethod>",
    "    <AllowedMethod>GET</AllowedMethod>",
    "    <AllowedHeader>Content-Type</AllowedHeader>",
    "    <AllowedHeader>Authorization</AllowedHeader>",
    "    <ExposeHeader>ETag</ExposeHeader>",
    "    <ExposeHeader>Content-Length</ExposeHeader>",
    "    <ExposeHeader>Content-Type</ExposeHeader>",
    "    <MaxAgeSeconds>3000</MaxAgeSeconds>",
    "  </CORSRule>",
    "</CORSConfiguration>",
  ].join("\n")
}

function desiredLifecycleXml(): string {
  return [
    "<LifecycleConfiguration>",
    "  <Rule>",
    "    <ID>abort-incomplete-multipart-uploads</ID>",
    "    <Status>Enabled</Status>",
    "    <Prefix></Prefix>",
    "    <AbortIncompleteMultipartUpload>",
    "      <DaysAfterInitiation>1</DaysAfterInitiation>",
    "    </AbortIncompleteMultipartUpload>",
    "  </Rule>",
    "</LifecycleConfiguration>",
  ].join("\n")
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

function canonicalQuery(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([key, value]) => [encodeURIComponent(key), encodeURIComponent(value)] as const)
    .sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue))
    .map(([key, value]) => `${key}=${value}`)
    .join("&")
}

function buildUrl(input: SignedRequestInput): URL {
  const url = new URL(input.config.endpoint.toString())
  url.pathname = `/${encodeURIComponent(input.config.bucket)}`
  for (const [key, value] of Object.entries(input.query)) {
    url.searchParams.set(key, value)
  }
  return url
}

async function buildSignedRequest(input: SignedRequestInput): Promise<Request> {
  const url = buildUrl(input)
  const payloadHash = await sha256Hex(input.body ?? "")
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
    body: input.body,
  })
}

function normalizeXml(xml: string): string {
  return xml
    .replace(/<\?xml[^>]*>/g, "")
    .replace(/\s+xmlns(:\w+)?="[^"]*"/g, "")
    .replace(/<Filter\s*\/>/g, "<Filter></Filter>")
    .replace(/>\s+</g, "><")
    .replace(/\s+/g, " ")
    .trim()
}

async function getConfig(config: S3Config, kind: "cors" | "lifecycle"): Promise<string | null> {
  const response = await fetch(await buildSignedRequest({
    config,
    method: "GET",
    query: { [kind]: "" },
  }))
  const text = await response.text().catch(() => "")
  if (response.status === 404) {
    return null
  }
  if (!response.ok) {
    throw new Error(`GetBucket${kind} failed: ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 500)}` : ""}`)
  }
  return text
}

async function putConfig(config: S3Config, kind: "cors" | "lifecycle", body: string): Promise<void> {
  const response = await fetch(await buildSignedRequest({
    config,
    method: "PUT",
    query: { [kind]: "" },
    headers: { "content-type": "application/xml" },
    body,
  }))
  const text = await response.text().catch(() => "")
  if (!response.ok) {
    throw new Error(`PutBucket${kind} failed: ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 500)}` : ""}`)
  }
}

async function checkOrApply(input: {
  config: S3Config
  kind: "cors" | "lifecycle"
  desired: string
  apply: boolean
}): Promise<void> {
  const current = await getConfig(input.config, input.kind)
  const currentNormalized = current ? normalizeXml(current) : null
  const desiredNormalized = normalizeXml(input.desired)
  const matches = currentNormalized === desiredNormalized
  console.log(`${input.kind} status`, {
    exists: current != null,
    matches,
    apply: input.apply,
  })
  if (matches) {
    return
  }
  if (process.env.FILEBASE_BUCKET_CONFIG_VERBOSE === "true") {
    console.log(`${input.kind} current`, currentNormalized)
    console.log(`${input.kind} desired`, desiredNormalized)
  }
  if (!input.apply) {
    console.log(`${input.kind} would update; rerun with --apply to replace the bucket ${input.kind} configuration`)
    return
  }
  await putConfig(input.config, input.kind, input.desired)
  const updated = await getConfig(input.config, input.kind)
  const updatedNormalized = normalizeXml(updated ?? "")
  if (updatedNormalized !== desiredNormalized) {
    console.log(`${input.kind} updated current`, updatedNormalized)
    console.log(`${input.kind} updated desired`, desiredNormalized)
    throw new Error(`${input.kind} update did not read back as desired`)
  }
  console.log(`${input.kind} updated`)
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply")
  const skipLifecycle = process.argv.includes("--skip-lifecycle")
  const config = readConfig()
  const corsOrigins = readCorsOrigins()
  console.log("bucket config target", {
    endpoint: config.endpoint.origin,
    bucket: config.bucket,
    region: config.region,
    apply,
    skipLifecycle,
    corsOrigins,
  })
  await checkOrApply({
    config,
    kind: "cors",
    desired: desiredCorsXml(corsOrigins),
    apply,
  })
  if (skipLifecycle) {
    // Filebase currently reports lifecycle as unsupported for this bucket, so the
    // API reaper is the cleanup guarantee for incomplete multipart uploads.
    console.log("lifecycle skipped")
    return
  }
  await checkOrApply({
    config,
    kind: "lifecycle",
    desired: desiredLifecycleXml(),
    apply,
  })
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
