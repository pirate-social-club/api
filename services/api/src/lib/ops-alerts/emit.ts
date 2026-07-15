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
  let stuckRoyaltyProjections = 0
  const stuckRoyaltyProjectionCommunities = new Set<string>()
  const stuckRoyaltyProjectionSamples: Array<Record<string, unknown>> = []
  let staleLockedDeliveryAssets = 0
  const staleLockedDeliveryCommunities = new Set<string>()
  const staleLockedDeliverySamples: Array<Record<string, unknown>> = []
  let retriedLockedDeliveryJobs = 0
  const retriedLockedDeliveryCommunities = new Set<string>()
  const retriedLockedDeliverySamples: Array<Record<string, unknown>> = []
  let storyRegistrationReconciliationRequired = 0
  const storyRegistrationReconciliationCommunities = new Set<string>()
  const storyRegistrationReconciliationSamples: Array<Record<string, unknown>> = []

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
    if (signal.stuck_royalty_allocation_projections > 0) {
      stuckRoyaltyProjections += signal.stuck_royalty_allocation_projections
      stuckRoyaltyProjectionCommunities.add(signal.community_id)
      for (const sample of signal.stuck_royalty_allocation_projection_samples) {
        if (stuckRoyaltyProjectionSamples.length >= 10) break
        stuckRoyaltyProjectionSamples.push({ community_id: signal.community_id, ...sample })
      }
    }
    if (signal.stale_locked_delivery_assets > 0) {
      staleLockedDeliveryAssets += signal.stale_locked_delivery_assets
      staleLockedDeliveryCommunities.add(signal.community_id)
      for (const sample of signal.stale_locked_delivery_asset_samples) {
        if (staleLockedDeliverySamples.length >= 10) break
        staleLockedDeliverySamples.push({ community_id: signal.community_id, ...sample })
      }
    }
    if (signal.retried_locked_delivery_jobs > 0) {
      retriedLockedDeliveryJobs += signal.retried_locked_delivery_jobs
      retriedLockedDeliveryCommunities.add(signal.community_id)
      for (const sample of signal.retried_locked_delivery_job_samples) {
        if (retriedLockedDeliverySamples.length >= 10) break
        retriedLockedDeliverySamples.push({ community_id: signal.community_id, ...sample })
      }
    }
    if (signal.story_registration_reconciliation_required > 0) {
      storyRegistrationReconciliationRequired += signal.story_registration_reconciliation_required
      storyRegistrationReconciliationCommunities.add(signal.community_id)
      for (const sample of signal.story_registration_reconciliation_samples) {
        if (storyRegistrationReconciliationSamples.length >= 10) break
        storyRegistrationReconciliationSamples.push({ community_id: signal.community_id, ...sample })
      }
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
  if (stuckRoyaltyProjections > 0) {
    alerts.push({
      key: "stuck_royalty_allocation_projection_sync",
      severity: "high",
      title: "Verified royalty allocations waiting on projection sync",
      count: stuckRoyaltyProjections,
      community_ids: [...stuckRoyaltyProjectionCommunities].sort(),
      details: { samples: stuckRoyaltyProjectionSamples },
    })
  }
  if (staleLockedDeliveryAssets > 0) {
    alerts.push({
      key: "stale_locked_delivery_requested_assets",
      severity: "high",
      title: "Locked delivery assets stuck in requested state",
      count: staleLockedDeliveryAssets,
      community_ids: [...staleLockedDeliveryCommunities].sort(),
      details: { samples: staleLockedDeliverySamples },
    })
  }
  if (retriedLockedDeliveryJobs > 0) {
    alerts.push({
      key: "retried_locked_asset_delivery_jobs",
      severity: "medium",
      title: "Locked delivery jobs retried",
      count: retriedLockedDeliveryJobs,
      community_ids: [...retriedLockedDeliveryCommunities].sort(),
      details: { samples: retriedLockedDeliverySamples },
    })
  }
  if (storyRegistrationReconciliationRequired > 0) {
    alerts.push({
      key: "story_registration_reconciliation_required",
      severity: "high",
      title: "Story registration effects require transaction reconciliation",
      count: storyRegistrationReconciliationRequired,
      community_ids: [...storyRegistrationReconciliationCommunities].sort(),
      details: { samples: storyRegistrationReconciliationSamples },
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
