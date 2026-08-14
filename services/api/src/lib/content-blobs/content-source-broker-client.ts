import type { Env } from "../../env"
import {
  CONTENT_SOURCE_STORAGE_NAMESPACE,
  contentSourceObjectKey,
} from "@pirate/content-source-protocol"
import type {
  ContentSecurityScanJob,
  ContentSecurityScanResult,
  ContentSourceReadOutcome,
} from "../content-security/content-security-types"
import { conflictError, providerUnavailable } from "../errors"
import { sha256Hex } from "../crypto"

export const CONTENT_SOURCE_STORAGE_PROVIDER = "cloudflare_r2_private"
export { CONTENT_SOURCE_STORAGE_NAMESPACE }
export const CONTENT_SOURCE_STORAGE_ENDPOINT = "service://content-source-broker"

type StoredContentSource = {
  object: "content_source_object"
  content_blob: string
  status: "stored"
  storage_namespace: string
  storage_object_key: string
  size_bytes: number
  content_sha256: string
}

export function requireContentSourceBroker(env: Env): { service: Fetcher; secret: string } {
  const secret = env.CONTENT_SOURCE_BROKER_SHARED_SECRET?.trim() ?? ""
  if (!env.CONTENT_SOURCE_BROKER || !secret) {
    throw providerUnavailable("Content source storage is not configured")
  }
  return { service: env.CONTENT_SOURCE_BROKER, secret }
}

export function assertContentSourceBrokerConfigured(env: Env): void {
  requireContentSourceBroker(env)
}

function isStoredContentSource(value: unknown, expected: {
  contentBlobId: string
  sizeBytes: number
  sha256: string
}): value is StoredContentSource {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return record.object === "content_source_object"
    && record.content_blob === expected.contentBlobId
    && record.status === "stored"
    && record.storage_namespace === CONTENT_SOURCE_STORAGE_NAMESPACE
    && record.storage_object_key === contentSourceObjectKey(expected.contentBlobId)
    && record.size_bytes === expected.sizeBytes
    && record.content_sha256 === expected.sha256
}

export async function storeContentSource(input: {
  env: Env
  contentBlobId: string
  bytes: Uint8Array<ArrayBuffer>
  sha256: string
}): Promise<{
  storageProvider: string
  storageBucket: string
  storageObjectKey: string
  storageEndpoint: string
  contentHash: string
}> {
  const { service, secret } = requireContentSourceBroker(input.env)
  let response: Response
  try {
    response = await service.fetch(new Request(
      `https://content-source-broker.internal/objects/${encodeURIComponent(input.contentBlobId)}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/octet-stream",
          "content-length": String(input.bytes.byteLength),
          "x-content-sha256": input.sha256,
          "x-content-size": String(input.bytes.byteLength),
        },
        body: input.bytes,
      },
    ))
  } catch {
    throw providerUnavailable("Content source storage is unavailable")
  }
  if (response.status === 409) {
    throw conflictError("Content source storage conflicts with the verified upload")
  }
  if (!response.ok) {
    throw providerUnavailable(`Content source storage failed with status ${response.status}`)
  }

  const result = await response.json().catch(() => null)
  if (!isStoredContentSource(result, {
    contentBlobId: input.contentBlobId,
    sizeBytes: input.bytes.byteLength,
    sha256: input.sha256,
  })) {
    throw providerUnavailable("Content source storage returned invalid evidence")
  }
  return {
    storageProvider: CONTENT_SOURCE_STORAGE_PROVIDER,
    storageBucket: CONTENT_SOURCE_STORAGE_NAMESPACE,
    storageObjectKey: result.storage_object_key,
    storageEndpoint: CONTENT_SOURCE_STORAGE_ENDPOINT,
    contentHash: `0x${input.sha256}`,
  }
}

/** Read a verified plaintext source for server-side encryption. */
export async function readContentSource(input: {
  env: Env
  contentBlobId: string
  expectedSizeBytes: number
  expectedSha256: string
}): Promise<Uint8Array<ArrayBuffer>> {
  const { service, secret } = requireContentSourceBroker(input.env)
  let response: Response
  try {
    response = await service.fetch(new Request(
      `https://content-source-broker.internal/objects/${encodeURIComponent(input.contentBlobId)}`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${secret}`,
          "x-content-sha256": input.expectedSha256.replace(/^0x/, "").toLowerCase(),
          "x-content-size": String(input.expectedSizeBytes),
        },
      },
    ))
  } catch {
    throw providerUnavailable("Content source storage is unavailable")
  }
  if (!response.ok) {
    throw providerUnavailable(`Content source storage read failed with status ${response.status}`)
  }
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength !== input.expectedSizeBytes) {
    throw conflictError("Content source storage returned an unexpected byte count")
  }
  const actualSha256 = await sha256Hex(bytes)
  if (actualSha256 !== input.expectedSha256.replace(/^0x/, "").toLowerCase()) {
    throw conflictError("Content source storage returned a hash mismatch")
  }
  return bytes
}

function boundedText(value: unknown, maxLength = 256): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength ? value : null
}

function parseContentSecurityScanResult(value: unknown): ContentSecurityScanResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const outcome = record.outcome
  const findingCode = record.finding == null ? null : boundedText(record.finding)
  const errorCode = record.error_code == null ? null : boundedText(record.error_code)
  const formatOutcome = record.format_outcome
  const detectedMimeType = record.detected_mime_type == null ? null : boundedText(record.detected_mime_type)
  const formatFindingCode = record.format_finding_code == null ? null : boundedText(record.format_finding_code)
  const formatErrorCode = record.format_error_code == null ? null : boundedText(record.format_error_code)
  if (outcome !== "clean" && outcome !== "suspicious" && outcome !== "malicious" && outcome !== "error") {
    return null
  }
  if (outcome === "malicious" && (!findingCode || errorCode)) return null
  if (outcome === "error" && (findingCode || !errorCode)) return null
  if ((outcome === "clean" || outcome === "suspicious") && errorCode) return null
  if (formatOutcome !== "allow" && formatOutcome !== "reject" && formatOutcome !== "error") return null
  if (formatOutcome === "allow" && (!detectedMimeType || formatFindingCode || formatErrorCode)) return null
  if (formatOutcome === "reject" && (!formatFindingCode || formatErrorCode)) return null
  if (formatOutcome === "error" && (formatFindingCode || !formatErrorCode)) return null
  if (record.engine !== "clamav") return null
  if (typeof record.size_bytes !== "number" || !Number.isSafeInteger(record.size_bytes) || record.size_bytes <= 0) {
    return null
  }
  if (typeof record.duration_ms !== "number" || !Number.isSafeInteger(record.duration_ms) || record.duration_ms < 0) {
    return null
  }
  const job = boundedText(record.job, 132)
  const contentSha256 = boundedText(record.content_sha256, 64)
  const policyVersion = boundedText(record.policy_version)
  const engineVersion = boundedText(record.engine_version)
  const signatureVersion = boundedText(record.signature_version)
  const signatureDate = boundedText(record.signature_date)
  const engineImageDigest = boundedText(record.engine_image_digest, 71)
  const definitionDigest = boundedText(record.definition_digest, 64)
  const formatPolicyVersion = boundedText(record.format_policy_version)
  if (
    !job
    || !contentSha256
    || !/^[a-f0-9]{64}$/u.test(contentSha256)
    || !policyVersion
    || !engineVersion
    || !signatureVersion
    || !signatureDate
    || !Number.isFinite(Date.parse(signatureDate))
    || !engineImageDigest
    || !/^sha256:[a-f0-9]{64}$/u.test(engineImageDigest)
    || !definitionDigest
    || !/^[a-f0-9]{64}$/u.test(definitionDigest)
    || !formatPolicyVersion
  ) return null
  return {
    job,
    contentSha256,
    sizeBytes: record.size_bytes,
    outcome,
    policyVersion,
    engineVersion,
    signatureVersion,
    signatureDate,
    engineImageDigest,
    definitionDigest,
    findingCode,
    errorCode,
    formatPolicyVersion,
    formatOutcome,
    detectedMimeType,
    formatFindingCode,
    formatErrorCode,
    durationMs: record.duration_ms,
  }
}

export class ContentSourceScanError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    readonly readOutcome: ContentSourceReadOutcome,
    readonly bytesRead: number,
  ) {
    super("Content source scan failed")
  }
}

function brokerErrorCode(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "invalid_broker_response"
  const code = (value as Record<string, unknown>).code
  return typeof code === "string" && /^[a-z0-9_]{1,64}$/u.test(code) ? code : "invalid_broker_response"
}

function readOutcomeForBrokerCode(code: string): ContentSourceReadOutcome {
  if (code === "source_missing") return "source_missing"
  if (code === "source_metadata_mismatch") return "metadata_mismatch"
  if (code === "scanner_unavailable" || code === "scanner_not_configured") return "stream_error"
  return "scanner_rejected"
}

export async function scanContentSource(input: {
  env: Env
  job: ContentSecurityScanJob
}): Promise<{
  result: ContentSecurityScanResult
  bytesRead: number
  readOutcome: ContentSourceReadOutcome
}> {
  const { service, secret } = requireContentSourceBroker(input.env)
  let response: Response
  try {
    response = await service.fetch(new Request(
      `https://content-source-broker.internal/objects/${encodeURIComponent(input.job.contentBlobId)}/scan`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "x-content-scan-job": input.job.scanJobId,
          "x-content-sha256": input.job.expectedContentHash.slice(2),
          "x-content-size": String(input.job.expectedSizeBytes),
          "x-content-validation-profile": input.job.validationProfile,
          "x-content-declared-mime-type": input.job.declaredMimeType,
          ...(input.job.declaredFilename
            ? { "x-content-declared-filename-base64url": Buffer.from(input.job.declaredFilename).toString("base64url") }
            : {}),
        },
      },
    ))
  } catch {
    throw new ContentSourceScanError("broker_unavailable", true, "stream_error", 0)
  }
  const bytesReadText = response.headers.get("x-content-source-bytes-read")
  const bytesRead = bytesReadText == null ? 0 : Number(bytesReadText)
  if (!Number.isSafeInteger(bytesRead) || bytesRead < 0 || bytesRead > input.job.expectedSizeBytes) {
    throw new ContentSourceScanError("invalid_bytes_read", false, "metadata_mismatch", 0)
  }
  const body = await response.json().catch(() => null)
  const result = parseContentSecurityScanResult(body)
  if (result) {
    return {
      result,
      bytesRead,
      readOutcome: response.ok ? "completed" : "scanner_rejected",
    }
  }
  const code = brokerErrorCode(body)
  const retryable = response.status === 429 || response.status >= 500
  throw new ContentSourceScanError(code, retryable, readOutcomeForBrokerCode(code), bytesRead)
}
