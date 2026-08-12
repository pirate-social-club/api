import { afterEach, describe, expect, test } from "bun:test"
import { createControlPlaneTestClient } from "../../../tests/helpers"
import type { Client } from "../sql-client"
import {
  cancelContentSecurityScanJobsForRevokedReleases,
  findActiveContentSecurityScannerRelease,
  finishContentSecurityScanFailure,
  finishContentSecurityScanResult,
  insertContentSecurityScanJob,
  leaseContentSecurityScanJob,
} from "./content-security-repository"

const NOW = "2026-08-13T00:00:00.000Z"
const HASH = `0x${"a".repeat(64)}`
const ENGINE_IMAGE = `sha256:${"b".repeat(64)}`
const DEPLOYED_IMAGE = `sha256:${"c".repeat(64)}`
const DEFINITION = "d".repeat(64)
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.()
})

async function setup() {
  const database = await createControlPlaneTestClient({ includeAllMigrations: true })
  cleanups.push(database.cleanup)
  const client = database.client as unknown as Client
  await database.client.execute({
    sql: `
      INSERT INTO users (
        user_id, verification_state, verification_capabilities_json, created_at, updated_at
      ) VALUES (?1, 'unverified', '{}', ?2, ?2)
    `,
    args: ["usr_scan_fixture", NOW],
  })
  await database.client.execute({
    sql: `
      INSERT INTO communities (
        community_id, creator_user_id, display_name, membership_mode, status,
        provisioning_state, transfer_state, created_at, updated_at
      ) VALUES (?1, ?2, 'Scan fixture', 'open', 'active', 'active', 'none', ?3, ?3)
    `,
    args: ["cmt_scan_fixture", "usr_scan_fixture", NOW],
  })
  await database.client.execute({
    sql: `
      INSERT INTO content_blobs (
        content_blob_id, community_id, uploader_user_id, status, validation_profile,
        declared_mime_type, verified_size_bytes, verified_content_hash,
        security_scan_state, plaintext_retention_state, storage_ref,
        storage_provider, storage_bucket, storage_object_key, storage_endpoint,
        created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, 'uploaded', 'download_file_v1', 'text/csv', 12, ?4,
        'pending', 'active', ?5, 'cloudflare_r2_private', 'content-source/v1',
        'content-source/v1/cbl_scan_fixture', 'service://content-source-broker', ?6, ?6
      )
    `,
    args: [
      "cbl_scan_fixture",
      "cmt_scan_fixture",
      "usr_scan_fixture",
      HASH,
      "https://api.example/content",
      NOW,
    ],
  })
  await database.client.execute({
    sql: `
      INSERT INTO content_security_scanner_releases (
        scanner_release_id, security_scan_profile, status, source_revision,
        runtime_lock_sha256, base_image_digest, engine_image_digest, engine_version,
        signature_version, signature_date, definition_digest, deployed_image_digest,
        sbom_ref, corpus_evidence_ref, created_at, activated_at
      ) VALUES (
        'csr_release_fixture', 'clamav-text-v1', 'active', 'revision-fixture',
        ?1, ?2, ?3, '1.5.4', 'signatures-fixture', ?4, ?5, ?6,
        'sbom-fixture', 'corpus-fixture', ?4, ?4
      )
    `,
    args: ["e".repeat(64), `sha256:${"f".repeat(64)}`, ENGINE_IMAGE, NOW, DEFINITION, DEPLOYED_IMAGE],
  })
  const release = await findActiveContentSecurityScannerRelease({
    executor: client,
    securityScanProfile: "clamav-text-v1",
  })
  if (!release) throw new Error("release fixture missing")
  return { database, client, release }
}

async function createAndLease(maxAttempts = 4) {
  const setupResult = await setup()
  await insertContentSecurityScanJob({
    executor: setupResult.client,
    scanJobId: "csj_scan_fixture",
    contentBlobId: "cbl_scan_fixture",
    scannerRelease: setupResult.release,
    requestReason: "initial_upload",
    expectedContentHash: HASH,
    expectedSizeBytes: 12,
    maxAttempts,
    now: NOW,
  })
  const job = await leaseContentSecurityScanJob({
    client: setupResult.client,
    scanJobId: "csj_scan_fixture",
    leaseOwner: "worker-fixture-1",
    now: "2026-08-13T00:00:01.000Z",
    leaseExpiresAt: "2026-08-13T00:10:01.000Z",
  })
  if (!job) throw new Error("job fixture was not leased")
  return { ...setupResult, job }
}

describe("content security scan repository", () => {
  test("leases once and atomically projects clean immutable evidence", async () => {
    const { database, client, job } = await createAndLease()
    expect(job.attemptCount).toBe(1)
    expect(job).toMatchObject({
      validationProfile: "download_file_v1",
      declaredFilename: null,
      declaredMimeType: "text/csv",
    })
    expect(await leaseContentSecurityScanJob({
      client,
      scanJobId: job.scanJobId,
      leaseOwner: "worker-fixture-2",
      now: "2026-08-13T00:00:02.000Z",
      leaseExpiresAt: "2026-08-13T00:10:02.000Z",
    })).toBeNull()

    await expect(finishContentSecurityScanResult({
      client,
      job,
      result: {
        job: job.scanJobId,
        contentSha256: "f".repeat(64),
        sizeBytes: 12,
        outcome: "clean",
        policyVersion: "clamav-text-v1",
        engineVersion: "1.5.4",
        signatureVersion: "signatures-fixture",
        signatureDate: NOW,
        engineImageDigest: ENGINE_IMAGE,
        definitionDigest: DEFINITION,
        findingCode: null,
        errorCode: null,
        formatPolicyVersion: "text-download-formats-v1",
        formatOutcome: "allow",
        detectedMimeType: "text/csv",
        formatFindingCode: null,
        formatErrorCode: null,
        durationMs: 24,
      },
      scanResultId: "csr_mismatched_fixture",
      sourceReadAuditId: "cra_mismatched_fixture",
      readOutcome: "metadata_mismatch",
      bytesRead: 12,
      startedAt: "2026-08-13T00:00:01.000Z",
      completedAt: "2026-08-13T00:00:02.000Z",
    })).rejects.toThrow("result identity does not match")

    expect(await finishContentSecurityScanResult({
      client,
      job,
      result: {
        job: job.scanJobId,
        contentSha256: HASH.slice(2),
        sizeBytes: 12,
        outcome: "clean",
        policyVersion: "clamav-text-v1",
        engineVersion: "1.5.4",
        signatureVersion: "signatures-fixture",
        signatureDate: NOW,
        engineImageDigest: ENGINE_IMAGE,
        definitionDigest: DEFINITION,
        findingCode: null,
        errorCode: null,
        formatPolicyVersion: "text-download-formats-v1",
        formatOutcome: "allow",
        detectedMimeType: "text/csv",
        formatFindingCode: null,
        formatErrorCode: null,
        durationMs: 24,
      },
      scanResultId: "csr_result_fixture",
      sourceReadAuditId: "cra_fixture",
      readOutcome: "completed",
      bytesRead: 12,
      startedAt: "2026-08-13T00:00:01.000Z",
      completedAt: "2026-08-13T00:00:02.000Z",
    })).toBe("succeeded")

    const blob = await database.client.execute({
      sql: `SELECT status, security_scan_state, security_scan_result_ref FROM content_blobs WHERE content_blob_id = ?1`,
      args: [job.contentBlobId],
    })
    expect(blob.rows[0]).toEqual(expect.objectContaining({
      status: "verifying",
      security_scan_state: "clean",
      security_scan_result_ref: "csr_result_fixture",
    }))
    const evidence = await database.client.execute(
      "SELECT (SELECT COUNT(*) FROM content_security_scan_results) AS results, (SELECT COUNT(*) FROM content_source_read_audits) AS reads",
    )
    expect(evidence.rows[0]).toEqual(expect.objectContaining({ results: 1, reads: 1 }))
  })

  test("retries transient failures then dead-letters at the durable attempt limit", async () => {
    const { database, client, job } = await createAndLease(2)
    expect(await finishContentSecurityScanFailure({
      client,
      job,
      sourceReadAuditId: "cra_retry_1",
      readOutcome: "stream_error",
      bytesRead: 0,
      errorCode: "scanner_unavailable",
      startedAt: "2026-08-13T00:00:01.000Z",
      completedAt: "2026-08-13T00:00:02.000Z",
    })).toBe("retryable_error")
    const second = await leaseContentSecurityScanJob({
      client,
      scanJobId: job.scanJobId,
      leaseOwner: "worker-fixture-2",
      now: "2026-08-13T00:05:00.000Z",
      leaseExpiresAt: "2026-08-13T00:15:00.000Z",
    })
    if (!second) throw new Error("retry was not leased")
    expect(second.attemptCount).toBe(2)
    expect(await finishContentSecurityScanFailure({
      client,
      job: second,
      sourceReadAuditId: "cra_retry_2",
      readOutcome: "stream_error",
      bytesRead: 0,
      errorCode: "scanner_unavailable",
      startedAt: "2026-08-13T00:05:00.000Z",
      completedAt: "2026-08-13T00:05:01.000Z",
    })).toBe("dead_lettered")
    const stored = await database.client.execute({
      sql: "SELECT status, attempt_count, completed_at FROM content_security_scan_jobs WHERE scan_job_id = ?1",
      args: [job.scanJobId],
    })
    expect(stored.rows[0]).toEqual(expect.objectContaining({
      status: "dead_lettered",
      attempt_count: 2,
    }))
    expect(stored.rows[0]?.completed_at).not.toBeNull()
    const blob = await database.client.execute({
      sql: "SELECT status, security_scan_state, rejection_code FROM content_blobs WHERE content_blob_id = ?1",
      args: [job.contentBlobId],
    })
    expect(blob.rows[0]).toEqual(expect.objectContaining({
      status: "failed",
      security_scan_state: "pending",
      rejection_code: "security_scan_failed",
    }))
  })

  test("rejects invalid format evidence without calling clean malware malicious", async () => {
    const { database, client, job } = await createAndLease()
    expect(await finishContentSecurityScanResult({
      client,
      job,
      result: {
        job: job.scanJobId,
        contentSha256: HASH.slice(2),
        sizeBytes: 12,
        outcome: "clean",
        policyVersion: "clamav-text-v1",
        engineVersion: "1.5.4",
        signatureVersion: "signatures-fixture",
        signatureDate: NOW,
        engineImageDigest: ENGINE_IMAGE,
        definitionDigest: DEFINITION,
        findingCode: null,
        errorCode: null,
        formatPolicyVersion: "text-download-formats-v1",
        formatOutcome: "reject",
        detectedMimeType: null,
        formatFindingCode: "spreadsheet_formula_candidate",
        formatErrorCode: null,
        durationMs: 24,
      },
      scanResultId: "csr_format_rejected_fixture",
      sourceReadAuditId: "cra_format_rejected_fixture",
      readOutcome: "completed",
      bytesRead: 12,
      startedAt: "2026-08-13T00:00:01.000Z",
      completedAt: "2026-08-13T00:00:02.000Z",
    })).toBe("succeeded")

    const blob = await database.client.execute({
      sql: "SELECT status, security_scan_state, detected_mime_type, rejection_code FROM content_blobs WHERE content_blob_id = ?1",
      args: [job.contentBlobId],
    })
    expect(blob.rows[0]).toEqual(expect.objectContaining({
      status: "rejected",
      security_scan_state: "clean",
      detected_mime_type: null,
      rejection_code: "content_format_rejected",
    }))
  })

  test("records a terminal scanner error without treating the blob as verified", async () => {
    const { database, client, job } = await createAndLease(1)
    expect(await finishContentSecurityScanResult({
      client,
      job,
      result: {
        job: job.scanJobId,
        contentSha256: HASH.slice(2),
        sizeBytes: 12,
        outcome: "error",
        policyVersion: "clamav-text-v1",
        engineVersion: "1.5.4",
        signatureVersion: "signatures-fixture",
        signatureDate: NOW,
        engineImageDigest: ENGINE_IMAGE,
        definitionDigest: DEFINITION,
        findingCode: null,
        errorCode: "engine_error",
        formatPolicyVersion: "text-download-formats-v1",
        formatOutcome: "allow",
        detectedMimeType: "text/csv",
        formatFindingCode: null,
        formatErrorCode: null,
        durationMs: 24,
      },
      scanResultId: "csr_error_fixture",
      sourceReadAuditId: "cra_error_fixture",
      readOutcome: "scanner_rejected",
      bytesRead: 12,
      startedAt: "2026-08-13T00:00:01.000Z",
      completedAt: "2026-08-13T00:00:02.000Z",
    })).toBe("dead_lettered")

    const blob = await database.client.execute({
      sql: "SELECT status, security_scan_state, rejection_code FROM content_blobs WHERE content_blob_id = ?1",
      args: [job.contentBlobId],
    })
    expect(blob.rows[0]).toEqual(expect.objectContaining({
      status: "failed",
      security_scan_state: "error",
      rejection_code: "security_scan_failed",
    }))
  })

  test("refuses revoked releases and cancels their expired work", async () => {
    const { database, client, job } = await createAndLease()
    await database.client.execute({
      sql: `
        UPDATE content_security_scanner_releases
        SET status = 'revoked', retired_at = ?1
        WHERE scanner_release_id = ?2
      `,
      args: ["2026-08-13T00:01:00.000Z", job.scannerRelease.scannerReleaseId],
    })

    expect(await finishContentSecurityScanFailure({
      client,
      job,
      sourceReadAuditId: "cra_revoked_fixture",
      readOutcome: "stream_error",
      bytesRead: 0,
      errorCode: "scanner_unavailable",
      startedAt: "2026-08-13T00:00:01.000Z",
      completedAt: "2026-08-13T00:01:01.000Z",
    })).toBe("lease_lost")
    expect(await cancelContentSecurityScanJobsForRevokedReleases({
      client,
      now: "2026-08-13T00:10:02.000Z",
      limit: 25,
    })).toBe(1)

    const stored = await database.client.execute({
      sql: `
        SELECT jobs.status, jobs.last_error_code, blobs.status AS blob_status,
               blobs.security_scan_state, blobs.rejection_code,
               (SELECT COUNT(*) FROM content_source_read_audits) AS read_audits
        FROM content_security_scan_jobs AS jobs
        JOIN content_blobs AS blobs ON blobs.content_blob_id = jobs.content_blob_id
        WHERE jobs.scan_job_id = ?1
      `,
      args: [job.scanJobId],
    })
    expect(stored.rows[0]).toEqual(expect.objectContaining({
      status: "cancelled",
      last_error_code: "scanner_release_revoked",
      blob_status: "failed",
      security_scan_state: "pending",
      rejection_code: "scanner_release_revoked",
      read_audits: 0,
    }))
  })

  test("never leases queued work after its scanner release is revoked", async () => {
    const { database, client, release } = await setup()
    await insertContentSecurityScanJob({
      executor: client,
      scanJobId: "csj_revoked_before_lease",
      contentBlobId: "cbl_scan_fixture",
      scannerRelease: release,
      requestReason: "initial_upload",
      expectedContentHash: HASH,
      expectedSizeBytes: 12,
      maxAttempts: 4,
      now: NOW,
    })
    await database.client.execute({
      sql: `
        UPDATE content_security_scanner_releases
        SET status = 'revoked', retired_at = ?1
        WHERE scanner_release_id = ?2
      `,
      args: ["2026-08-13T00:01:00.000Z", release.scannerReleaseId],
    })

    expect(await leaseContentSecurityScanJob({
      client,
      scanJobId: "csj_revoked_before_lease",
      leaseOwner: "worker-fixture-1",
      now: "2026-08-13T00:01:01.000Z",
      leaseExpiresAt: "2026-08-13T00:11:01.000Z",
    })).toBeNull()
    expect(await cancelContentSecurityScanJobsForRevokedReleases({
      client,
      now: "2026-08-13T00:01:02.000Z",
      limit: 25,
    })).toBe(1)
  })
})
