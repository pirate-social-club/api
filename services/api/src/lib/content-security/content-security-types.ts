export const CONTENT_SECURITY_SCAN_MESSAGE_VERSION = 1 as const
export const CONTENT_SECURITY_INITIAL_SCAN_MAX_ATTEMPTS = 4

export type ContentSecurityScanMessage = {
  schema_version: typeof CONTENT_SECURITY_SCAN_MESSAGE_VERSION
  scan_job_id: string
}

export type ContentSecurityScanRequestReason =
  | "initial_upload"
  | "definition_refresh"
  | "buyer_report"
  | "moderation"
  | "operator"

export type ContentSecurityScanJobStatus =
  | "queued"
  | "running"
  | "retryable_error"
  | "succeeded"
  | "dead_lettered"
  | "cancelled"

export type ContentSecurityScanOutcome = "clean" | "suspicious" | "malicious" | "error"

export type ContentSecurityScannerRelease = {
  scannerReleaseId: string
  securityScanProfile: string
  engineVersion: string
  signatureVersion: string
  signatureDate: string
  engineImageDigest: string
  definitionDigest: string
  deployedImageDigest: string
}

export type ContentSecurityScanJob = {
  scanJobId: string
  contentBlobId: string
  scannerRelease: ContentSecurityScannerRelease
  scanSequence: number
  requestReason: ContentSecurityScanRequestReason
  expectedContentHash: string
  expectedSizeBytes: number
  validationProfile: "download_file_v1" | "deck_import_csv_v1"
  declaredFilename: string | null
  declaredMimeType: string
  attemptCount: number
  maxAttempts: number
  leaseOwner: string
}

export type ContentSecurityScanResult = {
  job: string
  contentSha256: string
  sizeBytes: number
  outcome: ContentSecurityScanOutcome
  policyVersion: string
  engineVersion: string
  signatureVersion: string
  signatureDate: string
  engineImageDigest: string
  definitionDigest: string
  findingCode: string | null
  errorCode: string | null
  formatPolicyVersion: string
  formatOutcome: "allow" | "reject" | "error"
  detectedMimeType: string | null
  formatFindingCode: string | null
  formatErrorCode: string | null
  durationMs: number
}

export type ContentSourceReadOutcome =
  | "completed"
  | "source_missing"
  | "metadata_mismatch"
  | "stream_error"
  | "scanner_rejected"

export function contentSecurityScanResultMatchesJob(
  result: ContentSecurityScanResult,
  job: ContentSecurityScanJob,
): boolean {
  const release = job.scannerRelease
  return result.job === job.scanJobId
    && `0x${result.contentSha256}` === job.expectedContentHash
    && result.sizeBytes === job.expectedSizeBytes
    && result.policyVersion === release.securityScanProfile
    && result.engineVersion === release.engineVersion
    && result.signatureVersion === release.signatureVersion
    && result.signatureDate === release.signatureDate
    && result.engineImageDigest === release.engineImageDigest
    && result.definitionDigest === release.definitionDigest
}

export function parseContentSecurityScanMessage(value: unknown): ContentSecurityScanMessage | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const candidate = value as Record<string, unknown>
  if (candidate.schema_version !== CONTENT_SECURITY_SCAN_MESSAGE_VERSION) return null
  if (typeof candidate.scan_job_id !== "string" || !/^csj_[A-Za-z0-9_-]{1,128}$/u.test(candidate.scan_job_id)) {
    return null
  }
  return {
    schema_version: CONTENT_SECURITY_SCAN_MESSAGE_VERSION,
    scan_job_id: candidate.scan_job_id,
  }
}
