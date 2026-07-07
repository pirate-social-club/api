import type {
  CommunityPublishAlertSignals,
  OpsAlert,
  OpsAlertSeverity,
} from "./types"
import { OPS_ACTIONABLE_FAILURE_CODES, OPS_HIGH_SEVERITY_CODES } from "./types"

export interface AlertDeduper {
  hasSent(alertKey: string, bucketStartMs: number): Promise<boolean>
  markSent(alertKey: string, bucketStartMs: number): Promise<void>
}

export function buildOpsAlerts(signals: CommunityPublishAlertSignals[]): OpsAlert[] {
  const byCode = new Map<string, { count: number; communities: Set<string> }>()
  let deadJobs = 0
  const deadJobCommunities = new Set<string>()

  for (const signal of signals) {
    for (const { code, count } of signal.failure_codes) {
      if (!OPS_ACTIONABLE_FAILURE_CODES.has(code)) continue
      const entry = byCode.get(code) ?? { count: 0, communities: new Set<string>() }
      entry.count += count
      entry.communities.add(signal.community_id)
      byCode.set(code, entry)
    }
    if (signal.terminal_failed_finalize_jobs > 0) {
      deadJobs += signal.terminal_failed_finalize_jobs
      deadJobCommunities.add(signal.community_id)
    }
  }

  const alerts: OpsAlert[] = []
  for (const [code, entry] of byCode) {
    const severity: OpsAlertSeverity = OPS_HIGH_SEVERITY_CODES.has(code) ? "high" : "medium"
    alerts.push({
      key: `publish_failure:${code}`,
      severity,
      title: `Async publish failing: ${code}`,
      count: entry.count,
      community_ids: [...entry.communities].sort(),
    })
  }
  if (deadJobs > 0) {
    alerts.push({
      key: "terminal_failed_finalize_jobs",
      severity: "high",
      title: "post_publish_finalize jobs exhausted retries",
      count: deadJobs,
      community_ids: [...deadJobCommunities].sort(),
    })
  }
  return alerts
}

export function bucketStartMs(nowMs: number, bucketMs: number): number {
  return Math.floor(nowMs / bucketMs) * bucketMs
}

export async function dedupeOpsAlerts(input: {
  alerts: OpsAlert[]
  deduper: AlertDeduper
  nowMs: number
  bucketMs: number
}): Promise<OpsAlert[]> {
  const out: OpsAlert[] = []
  const bucket = bucketStartMs(input.nowMs, input.bucketMs)
  for (const alert of input.alerts) {
    if (!(await input.deduper.hasSent(alert.key, bucket))) {
      out.push(alert)
    }
  }
  return out
}

export async function markOpsAlertsSent(input: {
  alerts: OpsAlert[]
  deduper: AlertDeduper
  nowMs: number
  bucketMs: number
}): Promise<void> {
  const bucket = bucketStartMs(input.nowMs, input.bucketMs)
  for (const alert of input.alerts) {
    await input.deduper.markSent(alert.key, bucket)
  }
}
