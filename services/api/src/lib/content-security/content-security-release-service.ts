import { createHash } from "node:crypto"
import { auditEventInsert } from "../audit"
import type { DbExecutor } from "../db-helpers"
import { conflictError, internalError, notFoundError } from "../errors"
import { requiredString, rowValue, stringOrNull } from "../sql-row"
import type { Client } from "../sql-client"
import { withTransaction } from "../transactions"

export type ContentSecurityScannerReleaseStatus = "staged" | "active" | "retired" | "revoked"

export type ContentSecurityScannerReleaseRecord = {
  scannerReleaseId: string
  securityScanProfile: string
  status: ContentSecurityScannerReleaseStatus
  sourceRevision: string
  runtimeLockSha256: string
  baseImageDigest: string
  engineImageDigest: string
  engineVersion: string
  signatureVersion: string
  signatureDate: string
  definitionDigest: string
  deployedImageDigest: string
  sbomRef: string
  corpusEvidenceRef: string
  createdAt: string
  activatedAt: string | null
  retiredAt: string | null
}

export type StageContentSecurityScannerReleaseInput = Omit<
  ContentSecurityScannerReleaseRecord,
  "scannerReleaseId" | "status" | "createdAt" | "activatedAt" | "retiredAt"
> & {
  actorId: string
  authorizationRef: string
  reason: string
  now: string
}

function toRelease(row: unknown): ContentSecurityScannerReleaseRecord {
  return {
    scannerReleaseId: requiredString(row, "scanner_release_id"),
    securityScanProfile: requiredString(row, "security_scan_profile"),
    status: requiredString(row, "status") as ContentSecurityScannerReleaseStatus,
    sourceRevision: requiredString(row, "source_revision"),
    runtimeLockSha256: requiredString(row, "runtime_lock_sha256"),
    baseImageDigest: requiredString(row, "base_image_digest"),
    engineImageDigest: requiredString(row, "engine_image_digest"),
    engineVersion: requiredString(row, "engine_version"),
    signatureVersion: requiredString(row, "signature_version"),
    signatureDate: requiredString(row, "signature_date"),
    definitionDigest: requiredString(row, "definition_digest"),
    deployedImageDigest: requiredString(row, "deployed_image_digest"),
    sbomRef: requiredString(row, "sbom_ref"),
    corpusEvidenceRef: requiredString(row, "corpus_evidence_ref"),
    createdAt: requiredString(row, "created_at"),
    activatedAt: stringOrNull(rowValue(row, "activated_at")),
    retiredAt: stringOrNull(rowValue(row, "retired_at")),
  }
}

const RELEASE_COLUMNS = `
  scanner_release_id, security_scan_profile, status, source_revision,
  runtime_lock_sha256, base_image_digest, engine_image_digest, engine_version,
  signature_version, signature_date, definition_digest, deployed_image_digest,
  sbom_ref, corpus_evidence_ref, created_at, activated_at, retired_at
`

function releaseIdentity(input: StageContentSecurityScannerReleaseInput): Record<string, string> {
  return {
    security_scan_profile: input.securityScanProfile,
    source_revision: input.sourceRevision,
    runtime_lock_sha256: input.runtimeLockSha256,
    base_image_digest: input.baseImageDigest,
    engine_image_digest: input.engineImageDigest,
    engine_version: input.engineVersion,
    signature_version: input.signatureVersion,
    signature_date: input.signatureDate,
    definition_digest: input.definitionDigest,
    deployed_image_digest: input.deployedImageDigest,
    sbom_ref: input.sbomRef,
    corpus_evidence_ref: input.corpusEvidenceRef,
  }
}

function deterministicReleaseId(input: StageContentSecurityScannerReleaseInput): string {
  const digest = createHash("sha256").update(JSON.stringify(releaseIdentity(input))).digest("hex")
  return `csr_${digest.slice(0, 32)}`
}

async function requireRelease(executor: DbExecutor, scannerReleaseId: string): Promise<ContentSecurityScannerReleaseRecord> {
  const result = await executor.execute({
    sql: `SELECT ${RELEASE_COLUMNS} FROM content_security_scanner_releases WHERE scanner_release_id = ?1 LIMIT 1`,
    args: [scannerReleaseId],
  })
  if (!result.rows[0]) throw notFoundError("Content security scanner release not found")
  return toRelease(result.rows[0])
}

function sameIdentity(release: ContentSecurityScannerReleaseRecord, input: StageContentSecurityScannerReleaseInput): boolean {
  return JSON.stringify({
    security_scan_profile: release.securityScanProfile,
    source_revision: release.sourceRevision,
    runtime_lock_sha256: release.runtimeLockSha256,
    base_image_digest: release.baseImageDigest,
    engine_image_digest: release.engineImageDigest,
    engine_version: release.engineVersion,
    signature_version: release.signatureVersion,
    signature_date: release.signatureDate,
    definition_digest: release.definitionDigest,
    deployed_image_digest: release.deployedImageDigest,
    sbom_ref: release.sbomRef,
    corpus_evidence_ref: release.corpusEvidenceRef,
  }) === JSON.stringify(releaseIdentity(input))
}

export async function stageContentSecurityScannerRelease(
  client: Client,
  input: StageContentSecurityScannerReleaseInput,
): Promise<ContentSecurityScannerReleaseRecord> {
  const scannerReleaseId = deterministicReleaseId(input)
  return await withTransaction(client, "write", async (tx) => {
    await tx.execute({
      sql: `
        INSERT INTO content_security_scanner_releases (
          scanner_release_id, security_scan_profile, status, source_revision,
          runtime_lock_sha256, base_image_digest, engine_image_digest, engine_version,
          signature_version, signature_date, definition_digest, deployed_image_digest,
          sbom_ref, corpus_evidence_ref, created_at
        ) VALUES (
          ?1, ?2, 'staged', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14
        ) ON CONFLICT (scanner_release_id) DO NOTHING
      `,
      args: [
        scannerReleaseId,
        input.securityScanProfile,
        input.sourceRevision,
        input.runtimeLockSha256,
        input.baseImageDigest,
        input.engineImageDigest,
        input.engineVersion,
        input.signatureVersion,
        input.signatureDate,
        input.definitionDigest,
        input.deployedImageDigest,
        input.sbomRef,
        input.corpusEvidenceRef,
        input.now,
      ],
    })
    const release = await requireRelease(tx, scannerReleaseId)
    if (!sameIdentity(release, input)) throw internalError("Scanner release identity conflict")
    const audit = await tx.execute({
      sql: "SELECT 1 AS existing FROM audit_log WHERE action = 'content_security.scanner_release_stage' AND target_id = ?1 LIMIT 1",
      args: [scannerReleaseId],
    })
    if (audit.rows.length === 0) {
      await tx.execute(auditEventInsert({
        action: "content_security.scanner_release_stage",
        actorId: input.actorId,
        actorType: "operator",
        createdAt: input.now,
        metadata: {
          authorization_ref: input.authorizationRef,
          reason: input.reason,
          security_scan_profile: input.securityScanProfile,
          release_identity: releaseIdentity(input),
        },
        targetId: scannerReleaseId,
        targetType: "content_security_scanner_release",
      }))
    }
    return release
  })
}

export async function activateContentSecurityScannerRelease(client: Client, input: {
  scannerReleaseId: string
  actorId: string
  authorizationRef: string
  reason: string
  now: string
}): Promise<ContentSecurityScannerReleaseRecord> {
  return await withTransaction(client, "write", async (tx) => {
    const release = await requireRelease(tx, input.scannerReleaseId)
    if (release.status === "active") return release
    if (release.status !== "staged") throw conflictError("Only a staged scanner release can be activated")
    const current = await tx.execute({
      sql: `
        SELECT scanner_release_id
        FROM content_security_scanner_releases
        WHERE security_scan_profile = ?1 AND status = 'active'
        LIMIT 1
      `,
      args: [release.securityScanProfile],
    })
    const previousActiveId = current.rows[0] ? requiredString(current.rows[0], "scanner_release_id") : null
    if (previousActiveId) {
      const retirement = await tx.execute({
        sql: `UPDATE content_security_scanner_releases SET status = 'retired', retired_at = ?1 WHERE scanner_release_id = ?2 AND status = 'active'`,
        args: [input.now, previousActiveId],
      })
      if ((retirement.rowsAffected ?? 0) !== 1) throw conflictError("Active scanner release changed concurrently")
    }
    const update = await tx.execute({
      sql: `UPDATE content_security_scanner_releases SET status = 'active', activated_at = ?1 WHERE scanner_release_id = ?2 AND status = 'staged'`,
      args: [input.now, input.scannerReleaseId],
    })
    if ((update.rowsAffected ?? 0) !== 1) throw conflictError("Scanner release changed concurrently")
    await tx.execute(auditEventInsert({
      action: "content_security.scanner_release_activate",
      actorId: input.actorId,
      actorType: "operator",
      createdAt: input.now,
      metadata: {
        authorization_ref: input.authorizationRef,
        reason: input.reason,
        previous_active_release: previousActiveId,
      },
      targetId: input.scannerReleaseId,
      targetType: "content_security_scanner_release",
    }))
    return await requireRelease(tx, input.scannerReleaseId)
  })
}

export async function revokeContentSecurityScannerRelease(client: Client, input: {
  scannerReleaseId: string
  actorId: string
  authorizationRef: string
  reason: string
  now: string
}): Promise<ContentSecurityScannerReleaseRecord> {
  return await withTransaction(client, "write", async (tx) => {
    const release = await requireRelease(tx, input.scannerReleaseId)
    if (release.status === "revoked") return release
    const update = await tx.execute({
      sql: `
        UPDATE content_security_scanner_releases
        SET status = 'revoked', retired_at = COALESCE(retired_at, ?1)
        WHERE scanner_release_id = ?2 AND status IN ('staged', 'active', 'retired')
      `,
      args: [input.now, input.scannerReleaseId],
    })
    if ((update.rowsAffected ?? 0) !== 1) throw conflictError("Scanner release changed concurrently")
    await tx.execute(auditEventInsert({
      action: "content_security.scanner_release_revoke",
      actorId: input.actorId,
      actorType: "operator",
      createdAt: input.now,
      metadata: {
        authorization_ref: input.authorizationRef,
        reason: input.reason,
        previous_status: release.status,
      },
      targetId: input.scannerReleaseId,
      targetType: "content_security_scanner_release",
    }))
    return await requireRelease(tx, input.scannerReleaseId)
  })
}
