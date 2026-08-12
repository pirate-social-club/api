import { hasValidBearerToken } from "@pirate/internal-service-auth"
import {
  CONTENT_SOURCE_MAX_BYTES,
  CONTENT_SOURCE_STORAGE_NAMESPACE,
  contentSourceObjectKey,
  isContentBlobId,
  isContentScanJobRef,
  isSha256Hex,
} from "@pirate/content-source-protocol"

export { CONTENT_SOURCE_MAX_BYTES, CONTENT_SOURCE_STORAGE_NAMESPACE }
const MAX_SCANNER_RESPONSE_BYTES = 64 * 1024

export type ContentSourceBrokerEnv = {
  ENVIRONMENT?: string
  CONTENT_SOURCE_OBJECTS: R2Bucket
  CONTENT_MALWARE_SCANNER_SERVICE: Fetcher
  CONTENT_SOURCE_BROKER_SHARED_SECRET?: string
  CONTENT_MALWARE_SCANNER_SHARED_SECRET?: string
}

class BrokerRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return Response.json(body, { status })
}

function requireAuthorization(request: Request, env: ContentSourceBrokerEnv): void {
  if (!(env.CONTENT_SOURCE_BROKER_SHARED_SECRET?.trim())) {
    throw new BrokerRequestError(503, "not_configured", "Broker authentication is not configured")
  }
  if (!hasValidBearerToken(request, env.CONTENT_SOURCE_BROKER_SHARED_SECRET)) {
    throw new BrokerRequestError(401, "unauthorized", "Unauthorized")
  }
}

function contentBlobId(url: URL): string | null {
  const match = /^\/objects\/([^/]+)(?:\/(scan))?$/u.exec(url.pathname)
  if (!match) return null
  let value: string
  try {
    value = decodeURIComponent(match[1] ?? "")
  } catch {
    return null
  }
  return isContentBlobId(value) ? value : null
}

function requiredHeader(request: Request, name: string): string {
  const value = request.headers.get(name)?.trim() ?? ""
  if (!value) throw new BrokerRequestError(400, "invalid_request", `Missing ${name} header`)
  return value
}

function expectedMetadata(request: Request): { sha256: string; sizeBytes: number } {
  const sha256 = requiredHeader(request, "x-content-sha256").toLowerCase()
  if (!isSha256Hex(sha256)) {
    throw new BrokerRequestError(400, "invalid_request", "Invalid expected SHA-256")
  }
  const sizeBytes = Number(requiredHeader(request, "x-content-size"))
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) {
    throw new BrokerRequestError(400, "invalid_request", "Invalid expected content size")
  }
  if (sizeBytes > CONTENT_SOURCE_MAX_BYTES) {
    throw new BrokerRequestError(413, "payload_too_large", "Content exceeds the source size limit")
  }
  return { sha256, sizeBytes }
}

function bytesToHex(value: ArrayBuffer): string {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

function hexToBytes(value: string): ArrayBuffer {
  const bytes = new Uint8Array(value.length / 2)
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16)
  }
  return bytes.buffer
}

function matchesExpectedObject(
  object: R2Object,
  blobId: string,
  expected: { sha256: string; sizeBytes: number },
): boolean {
  return object.size === expected.sizeBytes
    && object.customMetadata?.content_blob_id === blobId
    && object.customMetadata?.content_sha256 === expected.sha256
    && object.customMetadata?.size_bytes === String(expected.sizeBytes)
    && object.checksums.sha256 != null
    && bytesToHex(object.checksums.sha256) === expected.sha256
}

async function storeSourceObject(
  request: Request,
  env: ContentSourceBrokerEnv,
  blobId: string,
): Promise<Response> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase()
    !== "application/octet-stream") {
    throw new BrokerRequestError(415, "unsupported_media_type", "Source input must be application/octet-stream")
  }
  const expected = expectedMetadata(request)
  const contentLength = Number(request.headers.get("content-length") ?? "0")
  if (!Number.isSafeInteger(contentLength) || contentLength !== expected.sizeBytes) {
    throw new BrokerRequestError(400, "content_length_mismatch", "Content-Length does not match expected size")
  }
  if (!request.body) throw new BrokerRequestError(400, "invalid_request", "Missing source content")

  const key = contentSourceObjectKey(blobId)
  const existing = await env.CONTENT_SOURCE_OBJECTS.head(key)
  if (existing) {
    if (!matchesExpectedObject(existing, blobId, expected)) {
      throw new BrokerRequestError(409, "source_conflict", "Source object already exists with different bytes")
    }
    return jsonResponse({
      object: "content_source_object",
      content_blob: blobId,
      status: "stored",
      storage_namespace: CONTENT_SOURCE_STORAGE_NAMESPACE,
      storage_object_key: key,
      size_bytes: expected.sizeBytes,
      content_sha256: expected.sha256,
    })
  }

  let stored: R2Object | null
  try {
    stored = await env.CONTENT_SOURCE_OBJECTS.put(key, request.body, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/octet-stream" },
      customMetadata: {
        content_blob_id: blobId,
        content_sha256: expected.sha256,
        size_bytes: String(expected.sizeBytes),
      },
      sha256: hexToBytes(expected.sha256),
    })
  } catch {
    throw new BrokerRequestError(400, "source_integrity_failed", "Source object integrity verification failed")
  }
  const resolved = stored ?? await env.CONTENT_SOURCE_OBJECTS.head(key)
  if (!resolved || !matchesExpectedObject(resolved, blobId, expected)) {
    if (stored) await env.CONTENT_SOURCE_OBJECTS.delete(key).catch(() => undefined)
    throw new BrokerRequestError(409, "source_conflict", "Source object could not be stored safely")
  }

  console.info(JSON.stringify({
    component: "content_source_broker",
    operation: "store",
    outcome: "stored",
    content_blob_id: blobId,
    size_bytes: expected.sizeBytes,
  }))
  return jsonResponse({
    object: "content_source_object",
    content_blob: blobId,
    status: "stored",
    storage_namespace: CONTENT_SOURCE_STORAGE_NAMESPACE,
    storage_object_key: key,
    size_bytes: expected.sizeBytes,
    content_sha256: expected.sha256,
  }, 201)
}

async function scanSourceObject(
  request: Request,
  env: ContentSourceBrokerEnv,
  blobId: string,
): Promise<Response> {
  const expected = expectedMetadata(request)
  const jobRef = requiredHeader(request, "x-content-scan-job")
  if (!isContentScanJobRef(jobRef)) {
    throw new BrokerRequestError(400, "invalid_request", "Invalid scan job reference")
  }
  const validationProfile = requiredHeader(request, "x-content-validation-profile")
  const declaredMimeType = requiredHeader(request, "x-content-declared-mime-type")
  const declaredFilename = request.headers.get("x-content-declared-filename-base64url")?.trim() ?? ""
  if (validationProfile.length > 64 || declaredMimeType.length > 255 || declaredFilename.length > 1368) {
    throw new BrokerRequestError(400, "invalid_request", "Content policy metadata exceeds its limit")
  }
  const scannerSecret = env.CONTENT_MALWARE_SCANNER_SHARED_SECRET?.trim() ?? ""
  if (!scannerSecret) {
    throw new BrokerRequestError(503, "scanner_not_configured", "Scanner authentication is not configured")
  }

  const source = await env.CONTENT_SOURCE_OBJECTS.get(contentSourceObjectKey(blobId))
  if (!source) throw new BrokerRequestError(404, "source_missing", "Source object is missing")
  if (!matchesExpectedObject(source, blobId, expected)) {
    throw new BrokerRequestError(409, "source_metadata_mismatch", "Source object metadata does not match the job")
  }

  let bytesRead = 0
  const countedBody = source.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytesRead += chunk.byteLength
      controller.enqueue(chunk)
    },
  }))
  let scannerResponse: Response
  try {
    scannerResponse = await env.CONTENT_MALWARE_SCANNER_SERVICE.fetch(new Request(
      "https://content-malware-scanner.internal/scan",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${scannerSecret}`,
          "content-type": "application/octet-stream",
          "content-length": String(expected.sizeBytes),
          "x-content-scan-job": jobRef,
          "x-content-sha256": expected.sha256,
          "x-content-size": String(expected.sizeBytes),
          "x-content-validation-profile": validationProfile,
          "x-content-declared-mime-type": declaredMimeType,
          ...(declaredFilename ? { "x-content-declared-filename-base64url": declaredFilename } : {}),
        },
        body: countedBody,
      },
    ))
  } catch {
    throw new BrokerRequestError(502, "scanner_unavailable", "Scanner service is unavailable")
  }
  const responseLength = Number(scannerResponse.headers.get("content-length") ?? "0")
  if (Number.isFinite(responseLength) && responseLength > MAX_SCANNER_RESPONSE_BYTES) {
    throw new BrokerRequestError(502, "invalid_scanner_response", "Scanner response exceeded the limit")
  }
  const body = await scannerResponse.arrayBuffer()
  if (body.byteLength > MAX_SCANNER_RESPONSE_BYTES) {
    throw new BrokerRequestError(502, "invalid_scanner_response", "Scanner response exceeded the limit")
  }
  console.info(JSON.stringify({
    component: "content_source_broker",
    operation: "scan",
    outcome: scannerResponse.ok ? "completed" : "scanner_rejected",
    content_blob_id: blobId,
    scan_job_id: jobRef,
    bytes_read: bytesRead,
    scanner_status: scannerResponse.status,
  }))
  return new Response(body, {
    status: scannerResponse.status,
    headers: {
      "content-type": scannerResponse.headers.get("content-type") ?? "application/json",
      "x-content-source-bytes-read": String(bytesRead),
    },
  })
}

async function headSourceObject(
  request: Request,
  env: ContentSourceBrokerEnv,
  blobId: string,
): Promise<Response> {
  const expected = expectedMetadata(request)
  const object = await env.CONTENT_SOURCE_OBJECTS.head(contentSourceObjectKey(blobId))
  if (!object) throw new BrokerRequestError(404, "source_missing", "Source object is missing")
  if (!matchesExpectedObject(object, blobId, expected)) {
    throw new BrokerRequestError(409, "source_metadata_mismatch", "Source object metadata does not match")
  }
  return new Response(null, {
    status: 204,
    headers: {
      "x-content-size": String(object.size),
      "x-content-sha256": expected.sha256,
    },
  })
}

async function deleteSourceObject(
  request: Request,
  env: ContentSourceBrokerEnv,
  blobId: string,
): Promise<Response> {
  const expected = expectedMetadata(request)
  const key = contentSourceObjectKey(blobId)
  const object = await env.CONTENT_SOURCE_OBJECTS.head(key)
  if (!object) return new Response(null, { status: 204 })
  if (!matchesExpectedObject(object, blobId, expected)) {
    throw new BrokerRequestError(409, "source_metadata_mismatch", "Source object metadata does not match")
  }
  await env.CONTENT_SOURCE_OBJECTS.delete(key)
  if (await env.CONTENT_SOURCE_OBJECTS.head(key)) {
    throw new BrokerRequestError(503, "source_delete_unconfirmed", "Source deletion could not be confirmed")
  }
  console.info(JSON.stringify({
    component: "content_source_broker",
    operation: "delete",
    outcome: "deleted",
    content_blob_id: blobId,
  }))
  return new Response(null, { status: 204 })
}

export async function handleContentSourceBrokerRequest(
  request: Request,
  env: ContentSourceBrokerEnv,
): Promise<Response> {
  try {
    const url = new URL(request.url)
    if (url.pathname === "/health" && request.method === "GET") {
      return jsonResponse({
        ok: true,
        service: "content-source-broker",
        environment: env.ENVIRONMENT ?? "development",
      })
    }
    requireAuthorization(request, env)
    const blobId = contentBlobId(url)
    if (!blobId) return jsonResponse({ code: "not_found", message: "Not found" }, 404)
    if (url.pathname.endsWith("/scan")) {
      if (request.method !== "POST") {
        return jsonResponse({ code: "method_not_allowed", message: "Method not allowed" }, 405)
      }
      return await scanSourceObject(request, env, blobId)
    }
    if (request.method === "PUT") return await storeSourceObject(request, env, blobId)
    if (request.method === "HEAD") return await headSourceObject(request, env, blobId)
    if (request.method === "DELETE") return await deleteSourceObject(request, env, blobId)
    return jsonResponse({ code: "method_not_allowed", message: "Method not allowed" }, 405)
  } catch (error) {
    if (error instanceof BrokerRequestError) {
      return jsonResponse({ code: error.code, message: error.message }, error.status)
    }
    console.error(JSON.stringify({
      component: "content_source_broker",
      operation: "request",
      outcome: "failed",
      error_class: error instanceof Error ? error.name : "unknown",
    }))
    return jsonResponse({ code: "internal_error", message: "Internal error" }, 500)
  }
}
