import { describe, expect, test } from "bun:test"
import type { Env } from "../../env"
import { ContentSourceScanError } from "../content-blobs/content-source-broker-client"
import type { Client } from "../sql-client"
import {
  consumeContentSecurityScans,
} from "./content-security-consumer"
import type {
  ContentSecurityScanJob,
  ContentSecurityScanMessage,
  ContentSecurityScanResult,
} from "./content-security-types"
import { contentSecurityScanResultMatchesJob } from "./content-security-types"

const job: ContentSecurityScanJob = {
  scanJobId: "csj_fixture",
  contentBlobId: "cbl_fixture",
  scannerRelease: {
    scannerReleaseId: "csr_release",
    securityScanProfile: "clamav-text-v1",
    engineVersion: "1.5.4",
    signatureVersion: "signatures-fixture",
    signatureDate: "2026-08-13T00:00:00.000Z",
    engineImageDigest: `sha256:${"b".repeat(64)}`,
    definitionDigest: "c".repeat(64),
    deployedImageDigest: `sha256:${"d".repeat(64)}`,
  },
  scanSequence: 1,
  requestReason: "initial_upload",
  expectedContentHash: `0x${"a".repeat(64)}`,
  expectedSizeBytes: 12,
  attemptCount: 1,
  maxAttempts: 4,
  leaseOwner: "worker-fixture",
}

const result: ContentSecurityScanResult = {
  job: job.scanJobId,
  contentSha256: job.expectedContentHash.slice(2),
  sizeBytes: job.expectedSizeBytes,
  outcome: "clean",
  policyVersion: job.scannerRelease.securityScanProfile,
  engineVersion: job.scannerRelease.engineVersion,
  signatureVersion: job.scannerRelease.signatureVersion,
  signatureDate: job.scannerRelease.signatureDate,
  engineImageDigest: job.scannerRelease.engineImageDigest,
  definitionDigest: job.scannerRelease.definitionDigest,
  findingCode: null,
  errorCode: null,
  durationMs: 20,
}

function message() {
  let action: "ack" | "retry" | null = null
  const value: Message<ContentSecurityScanMessage> = {
    id: "msg_fixture",
    timestamp: new Date("2026-08-13T00:00:00.000Z"),
    body: { schema_version: 1, scan_job_id: job.scanJobId },
    attempts: 1,
    ack: () => { action = "ack" },
    retry: () => { action = "retry" },
  }
  return { action: () => action, value }
}

function batch(messages: Message<ContentSecurityScanMessage>[]) {
  let acked = false
  return {
    acked: () => acked,
    value: {
      queue: "content-security-scan-staging",
      messages,
      metadata: { metrics: { backlogCount: messages.length, backlogBytes: 32 } },
      ackAll: () => { acked = true },
      retryAll: () => undefined,
    } satisfies MessageBatch<ContentSecurityScanMessage>,
  }
}

const enabledEnv = { CONTENT_SECURITY_SCAN_CONSUMER_ENABLED: "true" } as Env
const client = {} as Client
const fixedNow = () => new Date("2026-08-13T00:00:01.000Z")

describe("content security scan consumer", () => {
  test("binds scanner results to every release and content identity field", () => {
    expect(contentSecurityScanResultMatchesJob(result, job)).toBe(true)
    expect(contentSecurityScanResultMatchesJob({ ...result, signatureVersion: "stale" }, job)).toBe(false)
    expect(contentSecurityScanResultMatchesJob({ ...result, contentSha256: "f".repeat(64) }, job)).toBe(false)
    expect(contentSecurityScanResultMatchesJob({ ...result, job: "csj_other" }, job)).toBe(false)
  })

  test("acknowledges telemetry-only batches while the consumer gate is off", async () => {
    const queued = message()
    const messages = batch([queued.value])
    await consumeContentSecurityScans({ batch: messages.value, env: {} })
    expect(messages.acked()).toBe(true)
    expect(queued.action()).toBeNull()
  })

  test("acks a clean result only after durable result projection", async () => {
    const queued = message()
    let projected = false
    await consumeContentSecurityScans({
      batch: batch([queued.value]).value,
      env: enabledEnv,
      client,
      now: fixedNow,
      dependencies: {
        lease: async () => job,
        scan: async () => ({ result, bytesRead: 12, readOutcome: "completed" }),
        finishResult: async (input) => {
          expect(input.result).toEqual(result)
          projected = true
          return "succeeded"
        },
        makeId: (prefix) => `${prefix}_fixture`,
      },
    })
    expect(projected).toBe(true)
    expect(queued.action()).toBe("ack")
  })

  test("dead-letters mismatched scanner identity without recording it as a result", async () => {
    const queued = message()
    let forceDeadLetter = false
    await consumeContentSecurityScans({
      batch: batch([queued.value]).value,
      env: enabledEnv,
      client,
      now: fixedNow,
      dependencies: {
        lease: async () => job,
        scan: async () => ({
          result: { ...result, engineImageDigest: `sha256:${"f".repeat(64)}` },
          bytesRead: 12,
          readOutcome: "completed",
        }),
        finishFailure: async (input) => {
          forceDeadLetter = input.forceDeadLetter === true
          return "dead_lettered"
        },
        finishResult: async () => { throw new Error("mismatched result must not be recorded") },
        makeId: (prefix) => `${prefix}_fixture`,
      },
    })
    expect(forceDeadLetter).toBe(true)
    expect(queued.action()).toBe("ack")
  })

  test("retries a transient broker failure after persisting attempt evidence", async () => {
    const queued = message()
    await consumeContentSecurityScans({
      batch: batch([queued.value]).value,
      env: enabledEnv,
      client,
      now: fixedNow,
      dependencies: {
        lease: async () => job,
        scan: async () => {
          throw new ContentSourceScanError("scanner_unavailable", true, "stream_error", 0)
        },
        finishFailure: async (input) => {
          expect(input.errorCode).toBe("scanner_unavailable")
          return "retryable_error"
        },
        makeId: (prefix) => `${prefix}_fixture`,
      },
    })
    expect(queued.action()).toBe("retry")
  })
})
