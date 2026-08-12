import type { Env } from "../../env"
import {
  ContentSourceScanError,
  scanContentSource,
} from "../content-blobs/content-source-broker-client"
import { makeId, nowIso } from "../helpers"
import { getControlPlaneClient } from "../runtime-deps"
import type { Client } from "../sql-client"
import {
  boundedContentSecurityErrorCode,
  finishContentSecurityScanFailure,
  finishContentSecurityScanResult,
  leaseContentSecurityScanJob,
} from "./content-security-repository"
import {
  contentSecurityScanResultMatchesJob,
  parseContentSecurityScanMessage,
  type ContentSecurityScanMessage,
} from "./content-security-types"

const SCAN_JOB_LEASE_MS = 10 * 60 * 1000

type ContentSecurityConsumerDependencies = {
  lease: typeof leaseContentSecurityScanJob
  scan: typeof scanContentSource
  finishFailure: typeof finishContentSecurityScanFailure
  finishResult: typeof finishContentSecurityScanResult
  makeId: typeof makeId
}

const defaultDependencies: ContentSecurityConsumerDependencies = {
  lease: leaseContentSecurityScanJob,
  scan: scanContentSource,
  finishFailure: finishContentSecurityScanFailure,
  finishResult: finishContentSecurityScanResult,
  makeId,
}

function literalTrue(value: string | undefined): boolean {
  return String(value ?? "").trim().toLowerCase() === "true"
}

function retryDelaySeconds(attempts: number): number {
  return Math.min(300, Math.max(5, 5 * 2 ** Math.min(6, Math.max(0, attempts - 1))))
}

async function consumeOne(input: {
  env: Env
  client: Client
  message: Message<ContentSecurityScanMessage>
  now: () => Date
  dependencies: ContentSecurityConsumerDependencies
}): Promise<void> {
  const parsed = parseContentSecurityScanMessage(input.message.body)
  if (!parsed) {
    input.message.retry({ delaySeconds: retryDelaySeconds(input.message.attempts) })
    console.error(JSON.stringify({
      component: "content_security_scan",
      operation: "consume",
      outcome: "invalid_message",
      message_id: input.message.id,
      attempts: input.message.attempts,
    }))
    return
  }
  const startedAt = input.now()
  const leaseOwner = `scan-worker-${crypto.randomUUID()}`
  const job = await input.dependencies.lease({
    client: input.client,
    scanJobId: parsed.scan_job_id,
    leaseOwner,
    now: startedAt.toISOString(),
    leaseExpiresAt: new Date(startedAt.getTime() + SCAN_JOB_LEASE_MS).toISOString(),
  })
  if (!job) {
    input.message.ack()
    return
  }

  try {
    const scanned = await input.dependencies.scan({ env: input.env, job })
    const completedAt = input.now().toISOString()
    if (
      scanned.bytesRead !== job.expectedSizeBytes
      || !contentSecurityScanResultMatchesJob(scanned.result, job)
    ) {
      const outcome = await input.dependencies.finishFailure({
        client: input.client,
        job,
        sourceReadAuditId: input.dependencies.makeId("cra"),
        readOutcome: "metadata_mismatch",
        bytesRead: scanned.bytesRead,
        errorCode: "scanner_identity_mismatch",
        startedAt: startedAt.toISOString(),
        completedAt,
        forceDeadLetter: true,
      })
      input.message.ack()
      console.error(JSON.stringify({
        component: "content_security_scan",
        operation: "consume",
        outcome,
        scan_job_id: job.scanJobId,
        error_code: "scanner_identity_mismatch",
      }))
      return
    }
    const outcome = await input.dependencies.finishResult({
      client: input.client,
      job,
      result: scanned.result,
      scanResultId: input.dependencies.makeId("csr"),
      sourceReadAuditId: input.dependencies.makeId("cra"),
      readOutcome: scanned.readOutcome,
      bytesRead: scanned.bytesRead,
      startedAt: startedAt.toISOString(),
      completedAt,
    })
    if (outcome === "retryable_error" || outcome === "lease_lost") {
      input.message.retry({ delaySeconds: retryDelaySeconds(input.message.attempts) })
    } else {
      input.message.ack()
    }
    console.info(JSON.stringify({
      component: "content_security_scan",
      operation: "consume",
      outcome,
      scan_job_id: job.scanJobId,
      scan_outcome: scanned.result.outcome,
      attempt_number: job.attemptCount,
      bytes_read: scanned.bytesRead,
    }))
  } catch (error) {
    const scanError = error instanceof ContentSourceScanError ? error : null
    const completedAt = input.now().toISOString()
    const outcome = await input.dependencies.finishFailure({
      client: input.client,
      job,
      sourceReadAuditId: input.dependencies.makeId("cra"),
      readOutcome: scanError?.readOutcome ?? "stream_error",
      bytesRead: scanError?.bytesRead ?? 0,
      errorCode: scanError?.code ?? boundedContentSecurityErrorCode(error),
      startedAt: startedAt.toISOString(),
      completedAt,
      forceDeadLetter: scanError ? !scanError.retryable : false,
    }).catch(() => "lease_lost" as const)
    if (outcome === "retryable_error" || outcome === "lease_lost") {
      input.message.retry({ delaySeconds: retryDelaySeconds(input.message.attempts) })
    } else {
      input.message.ack()
    }
    console.error(JSON.stringify({
      component: "content_security_scan",
      operation: "consume",
      outcome,
      scan_job_id: job.scanJobId,
      error_code: scanError?.code ?? boundedContentSecurityErrorCode(error),
      attempt_number: job.attemptCount,
    }))
  }
}

export async function consumeContentSecurityScans(input: {
  batch: MessageBatch<ContentSecurityScanMessage>
  env: Env
  client?: Client
  now?: () => Date
  dependencies?: Partial<ContentSecurityConsumerDependencies>
}): Promise<void> {
  if (!literalTrue(input.env.CONTENT_SECURITY_SCAN_CONSUMER_ENABLED)) {
    input.batch.ackAll()
    console.info(JSON.stringify({
      component: "content_security_scan",
      operation: "consume",
      outcome: "telemetry_only",
      messages: input.batch.messages.length,
    }))
    return
  }
  const client = input.client ?? getControlPlaneClient(input.env)
  const now = input.now ?? (() => new Date(nowIso()))
  const dependencies = { ...defaultDependencies, ...input.dependencies }
  for (const message of input.batch.messages) {
    await consumeOne({ env: input.env, client, message, now, dependencies })
  }
}
