import type { Env } from "../../env"
import { sanitizeLogText } from "../observability/pipeline-log"
import { KvAlertDeduper } from "./dedupe"
import { bucketStartMs } from "./emit"
import { sendOpsAlerts } from "./sink"
import type { OpsAlert, OpsAlertSeverity } from "./types"

const DEFAULT_BUCKET_MS = 60 * 60 * 1000
const DEDUPE_TTL_SECONDS = 3 * 60 * 60

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
  return numberFromExtra(extra, "failed_posts")
    ?? numberFromExtra(extra, "enqueued_jobs")
    ?? numberFromExtra(extra, "failed")
    ?? numberFromExtra(extra, "errors")
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

async function deliverScheduledAlert(env: Env, alert: OpsAlert): Promise<void> {
  const kv = env.OPS_ALERT_DEDUPE
  if (!kv) {
    await sendOpsAlerts(env, [alert])
    return
  }

  const bucketMs = intFromEnv(env.OPS_ALERT_BUCKET_MS, DEFAULT_BUCKET_MS)
  const bucket = bucketStartMs(Date.now(), bucketMs)
  const deduper = new KvAlertDeduper(kv, DEDUPE_TTL_SECONDS)
  if (await deduper.hasSent(alert.key, bucket)) return

  const delivery = await sendOpsAlerts(env, [alert])
  if (delivery.delivered) {
    await deduper.markSent(alert.key, bucket)
  }
}

export async function captureScheduledError(
  env: Env,
  error: unknown,
  task: string,
): Promise<void> {
  await deliverScheduledAlert(env, {
    key: `scheduled_error:${task}`,
    severity: "high",
    title: `Scheduled task failed: ${task}`,
    count: 1,
    community_ids: [],
    details: detailsFromError(error),
  })
}

export async function captureScheduledWarning(
  env: Env,
  message: string,
  task: string,
  extra?: Record<string, unknown>,
  tags?: Record<string, string>,
): Promise<void> {
  const severity: OpsAlertSeverity = tags?.urgency === "high" ? "high" : "medium"
  await deliverScheduledAlert(env, {
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
