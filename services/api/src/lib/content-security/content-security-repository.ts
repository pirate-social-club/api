import { executeFirst, type DbExecutor } from "../db-helpers"
import { internalError } from "../errors"
import { requiredNumber, requiredString, rowValue, stringOrNull } from "../sql-row"
import type { Client } from "../sql-client"
import { withTransaction } from "../transactions"
import type {
  ContentSecurityScanJob,
  ContentSecurityScannerRelease,
  ContentSourceReadOutcome,
  ContentSecurityScanResult,
} from "./content-security-types"
import { contentSecurityScanResultMatchesJob } from "./content-security-types"

function toRelease(row: unknown): ContentSecurityScannerRelease {
  return {
    scannerReleaseId: requiredString(row, "scanner_release_id"),
    securityScanProfile: requiredString(row, "security_scan_profile"),
    engineVersion: requiredString(row, "engine_version"),
    signatureVersion: requiredString(row, "signature_version"),
    signatureDate: requiredString(row, "signature_date"),
    engineImageDigest: requiredString(row, "engine_image_digest"),
    definitionDigest: requiredString(row, "definition_digest"),
    deployedImageDigest: requiredString(row, "deployed_image_digest"),
  }
}

function toLeasedJob(row: unknown): ContentSecurityScanJob {
  return {
    scanJobId: requiredString(row, "scan_job_id"),
    contentBlobId: requiredString(row, "content_blob_id"),
    scannerRelease: toRelease(row),
    scanSequence: requiredNumber(row, "scan_sequence"),
    requestReason: requiredString(row, "request_reason") as ContentSecurityScanJob["requestReason"],
    expectedContentHash: requiredString(row, "expected_content_hash"),
    expectedSizeBytes: requiredNumber(row, "expected_size_bytes"),
    validationProfile: requiredString(row, "validation_profile") as ContentSecurityScanJob["validationProfile"],
    declaredFilename: stringOrNull(rowValue(row, "declared_filename")),
    declaredMimeType: requiredString(row, "declared_mime_type"),
    attemptCount: requiredNumber(row, "attempt_count"),
    maxAttempts: requiredNumber(row, "max_attempts"),
    leaseOwner: requiredString(row, "lease_owner"),
  }
}

export async function findActiveContentSecurityScannerRelease(input: {
  executor: DbExecutor
  securityScanProfile: string
}): Promise<ContentSecurityScannerRelease | null> {
  const result = await input.executor.execute({
    sql: `
      SELECT scanner_release_id, security_scan_profile, engine_version,
             signature_version, signature_date, engine_image_digest,
             definition_digest, deployed_image_digest
      FROM content_security_scanner_releases
      WHERE security_scan_profile = ?1 AND status = 'active'
      ORDER BY activated_at DESC, scanner_release_id DESC
      LIMIT 2
    `,
    args: [input.securityScanProfile],
  })
  if (result.rows.length > 1) {
    throw internalError("Multiple active content security scanner releases exist")
  }
  return result.rows[0] ? toRelease(result.rows[0]) : null
}

export async function insertContentSecurityScanJob(input: {
  executor: DbExecutor
  scanJobId: string
  contentBlobId: string
  scannerRelease: ContentSecurityScannerRelease
  requestReason: "initial_upload" | "definition_refresh" | "buyer_report" | "moderation" | "operator"
  expectedContentHash: string
  expectedSizeBytes: number
  maxAttempts: number
  now: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      INSERT INTO content_security_scan_jobs (
        scan_job_id, content_blob_id, scanner_release_id, scan_sequence,
        request_reason, security_scan_profile, expected_content_hash,
        expected_size_bytes, status, attempt_count, max_attempts,
        queued_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3,
        COALESCE((SELECT MAX(scan_sequence) + 1 FROM content_security_scan_jobs WHERE content_blob_id = ?2), 1),
        ?4, ?5, ?6, ?7, 'queued', 0, ?8, ?9, ?9, ?9
      )
    `,
    args: [
      input.scanJobId,
      input.contentBlobId,
      input.scannerRelease.scannerReleaseId,
      input.requestReason,
      input.scannerRelease.securityScanProfile,
      input.expectedContentHash,
      input.expectedSizeBytes,
      input.maxAttempts,
      input.now,
    ],
  })
}

export async function markContentSecurityScanDispatched(input: {
  client: Client
  scanJobId: string
  dispatchedAt: string
}): Promise<boolean> {
  const result = await input.client.execute({
    sql: `
      UPDATE content_security_scan_jobs
      SET updated_at = ?1
      WHERE scan_job_id = ?2 AND status IN ('queued', 'retryable_error')
    `,
    args: [input.dispatchedAt, input.scanJobId],
  })
  return (result.rowsAffected ?? 0) === 1
}

export async function listContentSecurityScanJobsForDispatch(input: {
  client: Client
  staleBefore: string
  limit: number
}): Promise<string[]> {
  const result = await input.client.execute({
    sql: `
      SELECT jobs.scan_job_id
      FROM content_security_scan_jobs AS jobs
      JOIN content_security_scanner_releases AS releases
        ON releases.scanner_release_id = jobs.scanner_release_id
      WHERE jobs.status IN ('queued', 'retryable_error')
        AND releases.status IN ('active', 'retired')
        AND jobs.updated_at <= ?1
        AND jobs.attempt_count < jobs.max_attempts
      ORDER BY jobs.updated_at ASC, jobs.scan_job_id ASC
      LIMIT ?2
    `,
    args: [input.staleBefore, input.limit],
  })
  return result.rows.map((row) => requiredString(row, "scan_job_id"))
}

export async function cancelContentSecurityScanJobsForRevokedReleases(input: {
  client: Client
  now: string
  limit: number
}): Promise<number> {
  return await withTransaction(input.client, "write", async (tx) => {
    const candidates = await tx.execute({
      sql: `
        SELECT jobs.scan_job_id, jobs.content_blob_id,
               jobs.expected_content_hash, jobs.expected_size_bytes
        FROM content_security_scan_jobs AS jobs
        JOIN content_security_scanner_releases AS releases
          ON releases.scanner_release_id = jobs.scanner_release_id
        WHERE releases.status = 'revoked'
          AND (
            jobs.status IN ('queued', 'retryable_error')
            OR (jobs.status = 'running' AND jobs.lease_expires_at <= ?1)
          )
        ORDER BY jobs.updated_at ASC, jobs.scan_job_id ASC
        LIMIT ?2
      `,
      args: [input.now, input.limit],
    })
    let cancelled = 0
    for (const row of candidates.rows) {
      const scanJobId = requiredString(row, "scan_job_id")
      const contentBlobId = requiredString(row, "content_blob_id")
      const expectedContentHash = requiredString(row, "expected_content_hash")
      const expectedSizeBytes = requiredNumber(row, "expected_size_bytes")
      const jobUpdate = await tx.execute({
        sql: `
          UPDATE content_security_scan_jobs
          SET status = 'cancelled', lease_owner = NULL, lease_expires_at = NULL,
              last_error_code = 'scanner_release_revoked', completed_at = ?1,
              updated_at = ?1
          WHERE scan_job_id = ?2
            AND (
              status IN ('queued', 'retryable_error')
              OR (status = 'running' AND lease_expires_at <= ?1)
            )
            AND EXISTS (
              SELECT 1 FROM content_security_scanner_releases AS releases
              WHERE releases.scanner_release_id = content_security_scan_jobs.scanner_release_id
                AND releases.status = 'revoked'
            )
        `,
        args: [input.now, scanJobId],
      })
      if ((jobUpdate.rowsAffected ?? 0) !== 1) continue
      const blobUpdate = await tx.execute({
        sql: `
          UPDATE content_blobs
          SET status = 'failed', rejection_code = 'scanner_release_revoked', updated_at = ?1
          WHERE content_blob_id = ?2
            AND verified_content_hash = ?3
            AND verified_size_bytes = ?4
            AND status IN ('uploaded', 'verifying')
        `,
        args: [input.now, contentBlobId, expectedContentHash, expectedSizeBytes],
      })
      if ((blobUpdate.rowsAffected ?? 0) !== 1) {
        throw internalError("Revoked content security scan projection did not match authoritative bytes")
      }
      cancelled += 1
    }
    return cancelled
  })
}

export async function leaseContentSecurityScanJob(input: {
  client: Client
  scanJobId: string
  leaseOwner: string
  now: string
  leaseExpiresAt: string
}): Promise<ContentSecurityScanJob | null> {
  return await withTransaction(input.client, "write", async (tx) => {
    const result = await tx.execute({
      sql: `
        UPDATE content_security_scan_jobs
        SET status = 'running',
            attempt_count = attempt_count + 1,
            lease_owner = ?1,
            lease_expires_at = ?2,
            started_at = COALESCE(started_at, ?3),
            last_error_code = NULL,
            updated_at = ?3
        WHERE scan_job_id = ?4
          AND attempt_count < max_attempts
          AND EXISTS (
            SELECT 1 FROM content_security_scanner_releases AS releases
            WHERE releases.scanner_release_id = content_security_scan_jobs.scanner_release_id
              AND releases.status IN ('active', 'retired')
          )
          AND (
            status IN ('queued', 'retryable_error')
            OR (status = 'running' AND lease_expires_at <= ?3)
          )
      `,
      args: [input.leaseOwner, input.leaseExpiresAt, input.now, input.scanJobId],
    })
    if ((result.rowsAffected ?? 0) !== 1) return null
    const row = await executeFirst(tx, {
      sql: `
        SELECT jobs.scan_job_id, jobs.content_blob_id, jobs.scan_sequence,
               jobs.request_reason, jobs.expected_content_hash,
               jobs.expected_size_bytes, jobs.attempt_count, jobs.max_attempts,
               jobs.lease_owner, blobs.validation_profile, blobs.declared_filename,
               blobs.declared_mime_type, releases.scanner_release_id,
               releases.security_scan_profile, releases.engine_version,
               releases.signature_version, releases.signature_date,
               releases.engine_image_digest, releases.definition_digest,
               releases.deployed_image_digest
        FROM content_security_scan_jobs AS jobs
        JOIN content_blobs AS blobs ON blobs.content_blob_id = jobs.content_blob_id
        JOIN content_security_scanner_releases AS releases
          ON releases.scanner_release_id = jobs.scanner_release_id
        WHERE jobs.scan_job_id = ?1 AND jobs.lease_owner = ?2
        LIMIT 1
      `,
      args: [input.scanJobId, input.leaseOwner],
    })
    if (!row) throw internalError("Leased content security scan job is missing")
    return toLeasedJob(row)
  })
}

function readPurpose(job: ContentSecurityScanJob): string {
  const purposes = {
    initial_upload: "initial_scan",
    definition_refresh: "definition_rescan",
    buyer_report: "buyer_report_rescan",
    moderation: "moderation_inspection",
    operator: "operator_rescan",
  } as const
  return purposes[job.requestReason]
}

async function insertReadAudit(input: {
  executor: DbExecutor
  sourceReadAuditId: string
  job: ContentSecurityScanJob
  bytesRead: number
  outcome: ContentSourceReadOutcome
  startedAt: string
  completedAt: string
}): Promise<void> {
  await input.executor.execute({
    sql: `
      INSERT INTO content_source_read_audits (
        source_read_audit_id, scan_job_id, content_blob_id, attempt_number,
        purpose, actor_role, expected_content_hash, expected_size_bytes,
        bytes_read, outcome, started_at, completed_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, 'scanner_job', ?6, ?7, ?8, ?9, ?10, ?11)
    `,
    args: [
      input.sourceReadAuditId,
      input.job.scanJobId,
      input.job.contentBlobId,
      input.job.attemptCount,
      readPurpose(input.job),
      input.job.expectedContentHash,
      input.job.expectedSizeBytes,
      input.bytesRead,
      input.outcome,
      input.startedAt,
      input.completedAt,
    ],
  })
}

export async function finishContentSecurityScanFailure(input: {
  client: Client
  job: ContentSecurityScanJob
  sourceReadAuditId: string
  readOutcome: ContentSourceReadOutcome
  bytesRead: number
  errorCode: string
  startedAt: string
  completedAt: string
  forceDeadLetter?: boolean
}): Promise<"retryable_error" | "dead_lettered" | "lease_lost"> {
  return await withTransaction(input.client, "write", async (tx) => {
    const terminal = input.forceDeadLetter === true || input.job.attemptCount >= input.job.maxAttempts
    const status = terminal ? "dead_lettered" : "retryable_error"
    const result = await tx.execute({
      sql: `
        UPDATE content_security_scan_jobs
        SET status = ?1, lease_owner = NULL, lease_expires_at = NULL,
            last_error_code = ?2, completed_at = CASE WHEN ?1 = 'dead_lettered' THEN ?3 ELSE NULL END,
            updated_at = ?3
        WHERE scan_job_id = ?4 AND status = 'running' AND lease_owner = ?5
          AND EXISTS (
            SELECT 1 FROM content_security_scanner_releases AS releases
            WHERE releases.scanner_release_id = content_security_scan_jobs.scanner_release_id
              AND releases.status IN ('active', 'retired')
          )
      `,
      args: [status, input.errorCode, input.completedAt, input.job.scanJobId, input.job.leaseOwner],
    })
    if ((result.rowsAffected ?? 0) !== 1) return "lease_lost"
    await insertReadAudit({ executor: tx, ...input, outcome: input.readOutcome })
    if (terminal) {
      const blobUpdate = await tx.execute({
        sql: `
          UPDATE content_blobs
          SET status = 'failed', rejection_code = 'security_scan_failed', updated_at = ?1
          WHERE content_blob_id = ?2
            AND verified_content_hash = ?3
            AND verified_size_bytes = ?4
            AND status IN ('uploaded', 'verifying')
        `,
        args: [
          input.completedAt,
          input.job.contentBlobId,
          input.job.expectedContentHash,
          input.job.expectedSizeBytes,
        ],
      })
      if ((blobUpdate.rowsAffected ?? 0) !== 1) {
        throw internalError("Failed content blob scan projection did not match authoritative bytes")
      }
    }
    return status
  })
}

export async function finishContentSecurityScanResult(input: {
  client: Client
  job: ContentSecurityScanJob
  result: ContentSecurityScanResult
  scanResultId: string
  sourceReadAuditId: string
  readOutcome: ContentSourceReadOutcome
  bytesRead: number
  startedAt: string
  completedAt: string
}): Promise<"succeeded" | "retryable_error" | "dead_lettered" | "lease_lost"> {
  if (!contentSecurityScanResultMatchesJob(input.result, input.job)) {
    throw internalError("Content security scan result identity does not match its job")
  }
  return await withTransaction(input.client, "write", async (tx) => {
    const processingError = input.result.outcome === "error" || input.result.formatOutcome === "error"
    const retryable = processingError && input.job.attemptCount < input.job.maxAttempts
    const jobStatus = retryable
      ? "retryable_error"
      : processingError ? "dead_lettered" : "succeeded"
    const jobUpdate = await tx.execute({
      sql: `
        UPDATE content_security_scan_jobs
        SET status = ?1, lease_owner = NULL, lease_expires_at = NULL,
            last_error_code = ?2,
            completed_at = CASE WHEN ?1 IN ('succeeded', 'dead_lettered') THEN ?3 ELSE NULL END,
            updated_at = ?3
        WHERE scan_job_id = ?4 AND status = 'running' AND lease_owner = ?5
          AND EXISTS (
            SELECT 1 FROM content_security_scanner_releases AS releases
            WHERE releases.scanner_release_id = content_security_scan_jobs.scanner_release_id
              AND releases.status IN ('active', 'retired')
          )
      `,
      args: [
        jobStatus,
        processingError ? input.result.errorCode ?? input.result.formatErrorCode : null,
        input.completedAt,
        input.job.scanJobId,
        input.job.leaseOwner,
      ],
    })
    if ((jobUpdate.rowsAffected ?? 0) !== 1) return "lease_lost"
    await insertReadAudit({ executor: tx, ...input, outcome: input.readOutcome })
    await tx.execute({
      sql: `
        INSERT INTO content_security_scan_results (
          scan_result_id, scan_job_id, content_blob_id, scanner_release_id,
          attempt_number, content_hash, size_bytes, outcome, security_scan_profile,
          scanner_policy_version, engine_version, signature_version, signature_date,
          engine_image_digest, definition_digest, finding_code, error_code,
          content_format_policy_version, content_format_outcome,
          detected_mime_type, content_format_finding_code,
          content_format_error_code, duration_ms, recorded_at
        ) VALUES (
          ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9,
          ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
          ?18, ?19, ?20, ?21, ?22, ?23, ?24
        )
      `,
      args: [
        input.scanResultId,
        input.job.scanJobId,
        input.job.contentBlobId,
        input.job.scannerRelease.scannerReleaseId,
        input.job.attemptCount,
        input.job.expectedContentHash,
        input.job.expectedSizeBytes,
        input.result.outcome,
        input.job.scannerRelease.securityScanProfile,
        input.result.policyVersion,
        input.result.engineVersion,
        input.result.signatureVersion,
        input.result.signatureDate,
        input.result.engineImageDigest,
        input.result.definitionDigest,
        input.result.findingCode,
        input.result.errorCode,
        input.result.formatPolicyVersion,
        input.result.formatOutcome,
        input.result.detectedMimeType,
        input.result.formatFindingCode,
        input.result.formatErrorCode,
        input.result.durationMs,
        input.completedAt,
      ],
    })
    if (retryable) return "retryable_error"

    const blobStatus = input.result.outcome === "malicious"
      ? "rejected"
      : input.result.outcome === "error" || input.result.formatOutcome === "error"
        ? "failed"
        : input.result.formatOutcome === "reject" ? "rejected" : "verifying"
    const rejectionCode = input.result.outcome === "malicious"
      ? "malware_detected"
      : input.result.outcome === "error" || input.result.formatOutcome === "error"
        ? "security_scan_failed"
        : input.result.formatOutcome === "reject" ? "content_format_rejected" : null
    const blobUpdate = await tx.execute({
      sql: `
        UPDATE content_blobs
        SET status = ?1,
            security_scan_state = ?2,
            security_scan_profile = ?3,
            scanner_engine_version = ?4,
            scanner_signature_version = ?5,
            security_scan_result_ref = ?6,
            security_scanned_at = ?7,
            rejection_code = ?8,
            detected_mime_type = ?9,
            updated_at = ?7
        WHERE content_blob_id = ?10
          AND verified_content_hash = ?11
          AND verified_size_bytes = ?12
          AND status IN ('uploaded', 'verifying')
      `,
      args: [
        blobStatus,
        input.result.outcome,
        input.job.scannerRelease.securityScanProfile,
        input.result.engineVersion,
        input.result.signatureVersion,
        input.scanResultId,
        input.completedAt,
        rejectionCode,
        input.result.formatOutcome === "allow" ? input.result.detectedMimeType : null,
        input.job.contentBlobId,
        input.job.expectedContentHash,
        input.job.expectedSizeBytes,
      ],
    })
    if ((blobUpdate.rowsAffected ?? 0) !== 1) {
      throw internalError("Content blob scan projection did not match authoritative bytes")
    }
    return jobStatus
  })
}

export function boundedContentSecurityErrorCode(value: unknown): string {
  const text = stringOrNull(rowValue(value, "code")) ?? (value instanceof Error ? value.name : "internal_error")
  const normalized = text.trim().toLowerCase().replace(/[^a-z0-9_]+/gu, "_").slice(0, 64)
  return normalized || "internal_error"
}
