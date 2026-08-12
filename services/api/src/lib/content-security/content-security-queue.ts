import type { Env } from "../../env"
import { providerUnavailable } from "../errors"
import { getControlPlaneClient } from "../runtime-deps"
import type { Client } from "../sql-client"
import {
  cancelContentSecurityScanJobsForRevokedReleases,
  findActiveContentSecurityScannerRelease,
  listContentSecurityScanJobsForDispatch,
  markContentSecurityScanDispatched,
} from "./content-security-repository"
import {
  CONTENT_SECURITY_INITIAL_SCAN_MAX_ATTEMPTS,
  CONTENT_SECURITY_SCAN_MESSAGE_VERSION,
  type ContentSecurityScanMessage,
  type ContentSecurityScannerRelease,
} from "./content-security-types"

const REDISPATCH_AFTER_MS = 5 * 60 * 1000
const REDISPATCH_BATCH_SIZE = 25

function literalTrue(value: string | undefined): boolean {
  return String(value ?? "").trim().toLowerCase() === "true"
}

function requireQueue(env: Env): Queue<ContentSecurityScanMessage> {
  if (!env.CONTENT_SECURITY_SCAN_QUEUE) {
    throw providerUnavailable("Content security scan queue is not configured")
  }
  return env.CONTENT_SECURITY_SCAN_QUEUE
}

export async function prepareInitialContentSecurityScan(input: {
  env: Env
  client: Client
  scanJobId: string
}): Promise<{
  scanJobId: string
  scannerRelease: ContentSecurityScannerRelease
  maxAttempts: number
} | null> {
  if (!literalTrue(input.env.CONTENT_SECURITY_SCAN_ENQUEUE_ENABLED)) return null
  requireQueue(input.env)
  const profile = input.env.CONTENT_SECURITY_SCAN_PROFILE?.trim() ?? ""
  if (!profile) throw providerUnavailable("Content security scan profile is not configured")
  const scannerRelease = await findActiveContentSecurityScannerRelease({
    executor: input.client,
    securityScanProfile: profile,
  })
  if (!scannerRelease) throw providerUnavailable("No active content security scanner release exists")
  return {
    scanJobId: input.scanJobId,
    scannerRelease,
    maxAttempts: CONTENT_SECURITY_INITIAL_SCAN_MAX_ATTEMPTS,
  }
}

export async function dispatchContentSecurityScanJob(input: {
  env: Env
  client: Client
  scanJobId: string
  dispatchedAt: string
}): Promise<"accepted" | "disabled" | "failed"> {
  if (!literalTrue(input.env.CONTENT_SECURITY_SCAN_ENQUEUE_ENABLED)) return "disabled"
  let queue: Queue<ContentSecurityScanMessage>
  try {
    queue = requireQueue(input.env)
    await queue.send({
      schema_version: CONTENT_SECURITY_SCAN_MESSAGE_VERSION,
      scan_job_id: input.scanJobId,
    }, { contentType: "json" })
    await markContentSecurityScanDispatched({
      client: input.client,
      scanJobId: input.scanJobId,
      dispatchedAt: input.dispatchedAt,
    })
    console.info(JSON.stringify({
      component: "content_security_scan",
      operation: "dispatch",
      outcome: "accepted",
      scan_job_id: input.scanJobId,
    }))
    return "accepted"
  } catch (error) {
    console.error(JSON.stringify({
      component: "content_security_scan",
      operation: "dispatch",
      outcome: "failed",
      scan_job_id: input.scanJobId,
      error_class: error instanceof Error ? error.name : "unknown",
    }))
    return "failed"
  }
}

export async function redispatchStaleContentSecurityScanJobs(input: {
  env: Env
  client?: Client
  now?: Date
}): Promise<{ enabled: boolean; cancelled: number; selected: number; accepted: number; failed: number }> {
  if (!literalTrue(input.env.CONTENT_SECURITY_SCAN_ENQUEUE_ENABLED) || !input.env.CONTENT_SECURITY_SCAN_QUEUE) {
    return { enabled: false, cancelled: 0, selected: 0, accepted: 0, failed: 0 }
  }
  const now = input.now ?? new Date()
  const client = input.client ?? getControlPlaneClient(input.env)
  const cancelled = await cancelContentSecurityScanJobsForRevokedReleases({
    client,
    now: now.toISOString(),
    limit: REDISPATCH_BATCH_SIZE,
  })
  const scanJobIds = await listContentSecurityScanJobsForDispatch({
    client,
    staleBefore: new Date(now.getTime() - REDISPATCH_AFTER_MS).toISOString(),
    limit: REDISPATCH_BATCH_SIZE,
  })
  let accepted = 0
  for (const scanJobId of scanJobIds) {
    const outcome = await dispatchContentSecurityScanJob({
      env: input.env,
      client,
      scanJobId,
      dispatchedAt: now.toISOString(),
    })
    if (outcome === "accepted") accepted += 1
  }
  return {
    enabled: true,
    cancelled,
    selected: scanJobIds.length,
    accepted,
    failed: scanJobIds.length - accepted,
  }
}

export function isContentSecurityScanQueueName(queueName: string): boolean {
  return queueName === "content-security-scan-development"
    || queueName === "content-security-scan-staging"
    || queueName === "content-security-scan-production"
}
