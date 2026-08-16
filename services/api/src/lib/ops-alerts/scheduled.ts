import type { Env } from "../../env"
import { makeId } from "../helpers"
import { sanitizeLogText } from "../observability/pipeline-log"
import { getControlPlaneClient } from "../runtime-deps"
import { KvAlertDeduper } from "./dedupe"
import {
  createOpsAlertDeliveryEvidenceStore,
  type OpsAlertDeliveryEvidenceStore,
} from "./delivery-evidence"
import { bucketStartMs, dedupeOpsAlerts, markOpsAlertsSent } from "./emit"
import { opsAlertBucketMs, opsAlertDedupeTtlSeconds } from "./policy"
import { sendOpsAlerts } from "./sink"
import type { OpsAlert, OpsAlertSeverity } from "./types"

export type ScheduledAlertDeliveryResult = {
  delivered: boolean
  deduplicated: boolean
  evidenceRecorded: boolean
  deliveryAttemptId: string | null
  sink: "none" | "log" | "email" | "webhook"
}

let testEvidenceStore: OpsAlertDeliveryEvidenceStore | null | undefined

type ScheduledAlertTick = {
  alerts: OpsAlert[]
}

const scheduledAlertTicks = new WeakMap<Env, ScheduledAlertTick>()

export type ScheduledAlertTickFlushResult = {
  collected: number
  suppressed: number
  deduplicated: number
  delivered: boolean
  sent: number
  sink: "none" | "log" | "email" | "webhook"
}

export function beginScheduledAlertTick(env: Env): Env {
  const tickEnv = Object.create(env) as Env
  scheduledAlertTicks.set(tickEnv, { alerts: [] })
  return tickEnv
}

export function setScheduledAlertEvidenceStoreForTests(
  store: OpsAlertDeliveryEvidenceStore | null | undefined,
): void {
  testEvidenceStore = store
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

function evidenceStore(env: Env): OpsAlertDeliveryEvidenceStore | null {
  if (testEvidenceStore !== undefined) return testEvidenceStore
  const databaseUrl = String(env.CONTROL_PLANE_DATABASE_URL || "").trim()
  const hasPostgresUrl = databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://")
  if (!env.CONTROL_PLANE_HYPERDRIVE && !hasPostgresUrl) return null
  return createOpsAlertDeliveryEvidenceStore(getControlPlaneClient(env))
}

function suppressedScheduledAlertResult(): ScheduledAlertDeliveryResult {
  return {
    delivered: true,
    deduplicated: true,
    evidenceRecorded: false,
    deliveryAttemptId: null,
    sink: "none",
  }
}

export async function flushScheduledAlertTick(env: Env): Promise<ScheduledAlertTickFlushResult> {
  const tick = scheduledAlertTicks.get(env)
  scheduledAlertTicks.delete(env)
  const collected = tick?.alerts.length ?? 0
  const alerts = tick?.alerts.filter((alert) => alert.severity !== "low") ?? []
  const suppressed = collected - alerts.length
  if (alerts.length === 0) {
    return { collected, suppressed, deduplicated: 0, delivered: true, sent: 0, sink: "none" }
  }

  const nowMs = Date.now()
  const bucketMs = (alert: OpsAlert) => opsAlertBucketMs(env, alert.severity)
  const kv = env.OPS_ALERT_DEDUPE
  const longestBucketMs = Math.max(...alerts.map(bucketMs))
  const deduper = kv ? new KvAlertDeduper(kv, opsAlertDedupeTtlSeconds(longestBucketMs)) : null
  const toSend = deduper
    ? await dedupeOpsAlerts({ alerts, deduper, nowMs, bucketMs })
    : alerts

  const store = evidenceStore(env)
  const evidenceAttempts: Array<{ attemptId: string; alert: OpsAlert }> = []
  if (store) {
    for (const alert of toSend) {
      const attemptId = makeId("oad")
      const bucket = bucketStartMs(nowMs, bucketMs(alert))
      try {
        await store.begin({
          attemptId,
          alertKey: alert.key,
          environment: env.ENVIRONMENT || "development",
          severity: alert.severity,
          alertCount: alert.count,
          bucketStartMs: bucket,
        })
        evidenceAttempts.push({ attemptId, alert })
      } catch (error) {
        console.error("[ops-alerts] durable evidence begin failed", {
          alert_key: alert.key,
          error: errorMessage(error),
        })
      }
    }
  }

  const delivery = await sendOpsAlerts(env, toSend)
  if (store) {
    for (const { attemptId } of evidenceAttempts) {
      try {
        await store.finish({
          attemptId,
          delivery: {
            ...delivery,
            sent: delivery.delivered ? 1 : 0,
          },
        })
      } catch (error) {
        console.error("[ops-alerts] durable evidence finish failed", {
          delivery_attempt_id: attemptId,
          error: errorMessage(error),
        })
      }
    }
  }
  if (delivery.delivered && deduper) {
    await markOpsAlertsSent({ alerts: toSend, deduper, nowMs, bucketMs })
  }

  return {
    collected,
    suppressed,
    deduplicated: alerts.length - toSend.length,
    delivered: delivery.delivered,
    sent: delivery.sent,
    sink: delivery.sink,
  }
}

async function deliverScheduledAlert(env: Env, alert: OpsAlert): Promise<ScheduledAlertDeliveryResult> {
  if (alert.severity === "low") return suppressedScheduledAlertResult()

  const tick = scheduledAlertTicks.get(env)
  if (tick) {
    tick.alerts.push(alert)
    return {
      delivered: true,
      deduplicated: false,
      evidenceRecorded: false,
      deliveryAttemptId: null,
      sink: "none",
    }
  }

  const kv = env.OPS_ALERT_DEDUPE
  const bucketMs = opsAlertBucketMs(env, alert.severity)
  const bucket = bucketStartMs(Date.now(), bucketMs)
  const deduper = kv ? new KvAlertDeduper(kv, opsAlertDedupeTtlSeconds(bucketMs)) : null
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
    key: `scheduled_warning:${task}`,
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
