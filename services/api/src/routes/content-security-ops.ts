import { Hono, type Context } from "hono"
import type { Env } from "../env"
import {
  activateContentSecurityScannerRelease,
  revokeContentSecurityScannerRelease,
  stageContentSecurityScannerRelease,
  type ContentSecurityScannerReleaseRecord,
} from "../lib/content-security/content-security-release-service"
import { badRequestError, internalError } from "../lib/errors"
import { nowIso } from "../lib/helpers"
import {
  authenticateOperatorCredential,
  CONTENT_SECURITY_SCANNER_RELEASE_MANAGE_SCOPE,
  requireOperatorScope,
  type OperatorActorContext,
} from "../lib/operator-credential-auth"
import { getControlPlaneClient } from "../lib/runtime-deps"
import type { Client } from "../lib/sql-client"

type ContentSecurityOpsEnv = { Bindings: Env }
const contentSecurityOps = new Hono<ContentSecurityOpsEnv>()

type Authenticator = (input: {
  env: Env
  authorization: string | undefined
}) => Promise<OperatorActorContext>

type Dependencies = {
  authenticate: Authenticator
  getClient: (env: Env) => Client
  now: () => string
  stage: typeof stageContentSecurityScannerRelease
  activate: typeof activateContentSecurityScannerRelease
  revoke: typeof revokeContentSecurityScannerRelease
}

const defaults: Dependencies = {
  authenticate: authenticateOperatorCredential,
  getClient: getControlPlaneClient,
  now: nowIso,
  stage: stageContentSecurityScannerRelease,
  activate: activateContentSecurityScannerRelease,
  revoke: revokeContentSecurityScannerRelease,
}

let testDependencies: Partial<Dependencies> = {}

export function setContentSecurityOpsDependenciesForTests(input: Partial<Dependencies>): void {
  testDependencies = input
}

function dependencies(): Dependencies {
  return { ...defaults, ...testDependencies }
}

function unixSeconds(value: string | null): number | null {
  if (value == null) return null
  const milliseconds = Date.parse(value)
  if (!Number.isFinite(milliseconds)) throw internalError("Scanner release timestamp is invalid")
  return Math.floor(milliseconds / 1000)
}

function serialize(release: ContentSecurityScannerReleaseRecord) {
  return {
    id: release.scannerReleaseId,
    object: "content_security_scanner_release" as const,
    security_scan_profile: release.securityScanProfile,
    status: release.status,
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
    created: unixSeconds(release.createdAt),
    activated_at: unixSeconds(release.activatedAt),
    retired_at: unixSeconds(release.retiredAt),
  }
}

async function operator(c: Context<ContentSecurityOpsEnv>, services: Dependencies) {
  const actor = await services.authenticate({
    env: c.env,
    authorization: c.req.header("authorization"),
  })
  requireOperatorScope(actor, CONTENT_SECURITY_SCANNER_RELEASE_MANAGE_SCOPE)
  return actor
}

async function body(c: Context<ContentSecurityOpsEnv>, keys: readonly string[]): Promise<Record<string, unknown>> {
  const value = await c.req.json().catch(() => null)
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badRequestError("Invalid request body")
  const record = value as Record<string, unknown>
  if (Object.keys(record).some((key) => !keys.includes(key))) throw badRequestError("Request contains unknown fields")
  return record
}

function text(record: Record<string, unknown>, key: string, maximum = 256): string {
  const value = record[key]
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > maximum) {
    throw badRequestError(`Invalid ${key}`)
  }
  return value.trim()
}

function sha256(record: Record<string, unknown>, key: string): string {
  const value = text(record, key, 64).toLowerCase()
  if (!/^[a-f0-9]{64}$/u.test(value)) throw badRequestError(`Invalid ${key}`)
  return value
}

function imageDigest(record: Record<string, unknown>, key: string): string {
  const value = text(record, key, 71).toLowerCase()
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) throw badRequestError(`Invalid ${key}`)
  return value
}

function isoTimestamp(record: Record<string, unknown>, key: string): string {
  const value = text(record, key)
  if (!Number.isFinite(Date.parse(value))) throw badRequestError(`Invalid ${key}`)
  return new Date(value).toISOString()
}

function auditInput(record: Record<string, unknown>) {
  return {
    authorizationRef: text(record, "authorization_ref", 128),
    reason: text(record, "reason", 500),
  }
}

function scannerReleaseId(value: string): string {
  if (!/^csr_[a-f0-9]{32}$/u.test(value)) throw badRequestError("Invalid scanner release id")
  return value
}

const STAGE_KEYS = [
  "security_scan_profile",
  "source_revision",
  "runtime_lock_sha256",
  "base_image_digest",
  "engine_image_digest",
  "engine_version",
  "signature_version",
  "signature_date",
  "definition_digest",
  "deployed_image_digest",
  "sbom_ref",
  "corpus_evidence_ref",
  "authorization_ref",
  "reason",
] as const

contentSecurityOps.use("*", async (c, next) => {
  await next()
  c.header("cache-control", "private, no-store, max-age=0, must-revalidate")
  c.header("pragma", "no-cache")
})

contentSecurityOps.post("/scanner-releases", async (c) => {
  const services = dependencies()
  const actor = await operator(c, services)
  const request = await body(c, STAGE_KEYS)
  const audit = auditInput(request)
  const release = await services.stage(services.getClient(c.env), {
    actorId: actor.operatorActorId,
    now: services.now(),
    ...audit,
    securityScanProfile: text(request, "security_scan_profile", 128),
    sourceRevision: text(request, "source_revision", 128),
    runtimeLockSha256: sha256(request, "runtime_lock_sha256"),
    baseImageDigest: imageDigest(request, "base_image_digest"),
    engineImageDigest: imageDigest(request, "engine_image_digest"),
    engineVersion: text(request, "engine_version", 128),
    signatureVersion: text(request, "signature_version", 128),
    signatureDate: isoTimestamp(request, "signature_date"),
    definitionDigest: sha256(request, "definition_digest"),
    deployedImageDigest: imageDigest(request, "deployed_image_digest"),
    sbomRef: text(request, "sbom_ref", 512),
    corpusEvidenceRef: text(request, "corpus_evidence_ref", 512),
  })
  return c.json(serialize(release), 201)
})

for (const [action, run] of [
  ["activate", (services: Dependencies, client: Client, input: Parameters<typeof activateContentSecurityScannerRelease>[1]) => services.activate(client, input)],
  ["revoke", (services: Dependencies, client: Client, input: Parameters<typeof revokeContentSecurityScannerRelease>[1]) => services.revoke(client, input)],
] as const) {
  contentSecurityOps.post(`/scanner-releases/:scannerReleaseId/${action}`, async (c) => {
    const services = dependencies()
    const actor = await operator(c, services)
    const request = await body(c, ["authorization_ref", "reason"])
    const releaseId = scannerReleaseId(c.req.param("scannerReleaseId"))
    const release = await run(services, services.getClient(c.env), {
      scannerReleaseId: releaseId,
      actorId: actor.operatorActorId,
      now: services.now(),
      ...auditInput(request),
    })
    return c.json(serialize(release))
  })
}

export default contentSecurityOps
