import type { Env } from "../../env"
import { makeId } from "../helpers"
import { sanitizeLogText } from "../observability/pipeline-log"
import { getControlPlaneClient } from "../runtime-deps"
import { KvAlertDeduper } from "./dedupe"
import {
  createOpsAlertDeliveryEvidenceStore,
  type OpsAlertDeliveryEvidenceStore,
} from "./delivery-evidence"
import { bucketStartMs } from "./emit"
import { sendOpsAlerts } from "./sink"
import type { OpsAlert, OpsAlertSeverity } from "./types"

const DEFAULT_BUCKET_MS = 60 * 60 * 1000
const DEFAULT_LOW_SEVERITY_BUCKET_MS = 24 * 60 * 60 * 1000
const MIN_DEDUPE_TTL_SECONDS = 3 * 60 * 60

export type ScheduledAlertDeliveryResult = {
  delivered: boolean
  deduplicated: boolean
  evidenceRecorded: boolean
  deliveryAttemptId: string | null
  sink: "none" | "log" | "email" | "webhook"
}

let testEvidenceStore: OpsAlertDeliveryEvidenceStore | null | undefined

export function setScheduledAlertEvidenceStoreForTests(
  store: OpsAlertDeliveryEvidenceStore | null | undefined,
): void {
  testEvidenceStore = store
}

function intFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function errorMessage(error: unknown): string {
  return sanitizeLogText(error instanceof Error ? error.message : String(error)) ?? "unknown_error"
}

function detailsFromError(error: unknown): Record<string, unknown> {
  return {
    error: errorMessage(error),
    error_name: error instanceof Error ? error.name : typeof error,
  }
}

function numberFromExtra(extra: Record<string, unknown> | undefined, key: string): number | null {
  const value = extra?.[key]
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null
}

function arrayLengthFromExtra(extra: Record<string, unknown> | undefined, key: string): number | null {
  const value = extra?.[key]
  return Array.isArray(value) && value.length > 0 ? value.length : null
}

function scheduledWarningCount(extra: Record<string, unknown> | undefined): number {
  return numberFromExtra(extra, "count")
    ?? numberFromExtra(extra, "failed_posts")
    ?? numberFromExtra(extra, "enqueued_jobs")
    ?? numberFromExtra(extra, "failed")
    ?? numberFromExtra(extra, "errors")
    ?? numberFromExtra(extra, "leasesApproachingExpiry")
    ?? numberFromExtra(extra, "deferred")
    ?? arrayLengthFromExtra(extra, "failed_communities")
    ?? arrayLengthFromExtra(extra, "communities")
    ?? 1
}

function communityIdsFromExtra(extra: Record<string, unknown> | undefined): string[] {
  const ids = new Set<string>()
  for (const key of ["communities", "failed_communities"]) {
    const value = extra?.[key]
    if (!Array.isArray(value)) continue
    for (const item of value) {
      if (!item || typeof item !== "object") continue
      const communityId = (item as { community_id?: unknown }).community_id
      if (typeof communityId === "string" && communityId.trim()) {
        ids.add(communityId)
      }
    }
  }
  return [...ids].sort()
}

function bucketMsForScheduledAlert(env: Env, alert: OpsAlert): number {
  if (alert.severity === "low") {
    return intFromEnv(env.OPS_ALERT_LOW_BUCKET_MS, DEFAULT_LOW_SEVERITY_BUCKET_MS)
  }
  return intFromEnv(env.OPS_ALERT_BUCKET_MS, DEFAULT_BUCKET_MS)
}

function ttlSecondsForBucket(bucketMs: number): number {
  return Math.max(MIN_DEDUPE_TTL_SECONDS, Math.ceil((bucketMs * 2) / 1000))
}

function evidenceStore(env: Env): OpsAlertDeliveryEvidenceStore | null {
  if (testEvidenceStore !== undefined) return testEvidenceStore
  if (!env.CONTROL_PLANE_HYPERDRIVE && !String(env.CONTROL_PLANE_DATABASE_URL || "").trim()) return null
  return createOpsAlertDeliveryEvidenceStore(getControlPlaneClient(env))
}

async function deliverScheduledAlert(env: Env, alert: OpsAlert): Promise<ScheduledAlertDeliveryResult> {
  const kv = env.OPS_ALERT_DEDUPE
  const bucketMs = bucketMsForScheduledAlert(env, alert)
  const bucket = bucketStartMs(Date.now(), bucketMs)
  const deduper = kv ? new KvAlertDeduper(kv, ttlSecondsForBucket(bucketMs)) : null
  if (deduper && await deduper.hasSent(alert.key, bucket)) {
    return {
      delivered: true,
      deduplicated: true,
      evidenceRecorded: false,
      deliveryAttemptId: null,
      sink: "none",
    }
  }

  const store = evidenceStore(env)
  const deliveryAttemptId = makeId("oad")
  let evidenceBegan = false
  if (store) {
    try {
      await store.begin({
        attemptId: deliveryAttemptId,
        alertKey: alert.key,
        environment: env.ENVIRONMENT || "development",
        severity: alert.severity,
        alertCount: alert.count,
        bucketStartMs: bucket,
      })
      evidenceBegan = true
    } catch (error) {
      console.error("[ops-alerts] durable evidence begin failed", {
        alert_key: alert.key,
        error: errorMessage(error),
      })
    }
  }

  const delivery = await sendOpsAlerts(env, [alert])
  let evidenceRecorded = false
  if (store && evidenceBegan) {
    try {
      await store.finish({ attemptId: deliveryAttemptId, delivery })
      evidenceRecorded = true
    } catch (error) {
      console.error("[ops-alerts] durable evidence finish failed", {
        alert_key: alert.key,
        delivery_attempt_id: deliveryAttemptId,
        error: errorMessage(error),
      })
    }
  }
  if (delivery.delivered && deduper) await deduper.markSent(alert.key, bucket)
  return {
    delivered: delivery.delivered,
    deduplicated: false,
    evidenceRecorded,
    deliveryAttemptId: evidenceBegan ? deliveryAttemptId : null,
    sink: delivery.sink,
  }
}

export async function captureScheduledError(
  env: Env,
  error: unknown,
  task: string,
): Promise<boolean> {
  return (await deliverScheduledAlert(env, {
    key: `scheduled_error:${task}`,
    severity: "high",
    title: `Scheduled task failed: ${task}`,
    count: 1,
    community_ids: [],
    details: detailsFromError(error),
  })).delivered
}

export async function captureScheduledWarning(
  env: Env,
  message: string,
  task: string,
  extra?: Record<string, unknown>,
  tags?: Record<string, string>,
): Promise<boolean> {
  return (await captureScheduledWarningWithEvidence(env, message, task, extra, tags)).delivered
}

export async function captureScheduledWarningWithEvidence(
  env: Env,
  message: string,
  task: string,
  extra?: Record<string, unknown>,
  tags?: Record<string, string>,
): Promise<ScheduledAlertDeliveryResult> {
  const severity: OpsAlertSeverity = tags?.urgency === "high"
    ? "high"
    : tags?.urgency === "low"
      ? "low"
      : "medium"
  return deliverScheduledAlert(env, {
    key: `scheduled_warning:${task}:${tags?.urgency ?? "normal"}`,
    severity,
    title: message,
    count: scheduledWarningCount(extra),
    community_ids: communityIdsFromExtra(extra),
    details: {
      task,
      ...extra,
      ...(tags ? { tags } : {}),
    },
  })
}
