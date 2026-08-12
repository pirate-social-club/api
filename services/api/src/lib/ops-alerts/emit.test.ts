import { describe, expect, test } from "bun:test"
import { buildOpsAlerts, dedupeOpsAlerts, markOpsAlertsSent, type AlertDeduper } from "./emit"
import type { CommunityPublishAlertSignals } from "./types"

class InMemoryDeduper implements AlertDeduper {
  private readonly seen = new Set<string>()
  readonly marks: string[] = []

  async hasSent(key: string, bucket: number): Promise<boolean> {
    const dedupeKey = `${key}:${bucket}`
    return this.seen.has(dedupeKey)
  }

  async markSent(key: string, bucket: number): Promise<void> {
    const dedupeKey = `${key}:${bucket}`
    this.marks.push(dedupeKey)
    this.seen.add(dedupeKey)
  }
}

const signals: CommunityPublishAlertSignals[] = [
  {
    community_id: "c1",
    failure_codes: [{ code: "listing_creation_failed", count: 2 }],
    terminal_failed_finalize_jobs: 0,
    stuck_royalty_allocation_projections: 0,
    stuck_royalty_allocation_projection_samples: [],
    stale_locked_delivery_assets: 0,
    stale_locked_delivery_asset_samples: [],
    failed_story_delivery_assets: 0,
    failed_story_delivery_asset_samples: [],
    retried_locked_delivery_jobs: 0,
    retried_locked_delivery_job_samples: [],
    story_registration_reconciliation_required: 0,
    story_registration_reconciliation_samples: [],
    stale_ready_job_lanes: [],
  },
  {
    community_id: "c2",
    failure_codes: [
      { code: "listing_creation_failed", count: 1 },
      { code: "internal_error", count: 4 },
      { code: "text_moderation_blocked", count: 9 },
    ],
    terminal_failed_finalize_jobs: 3,
    stuck_royalty_allocation_projections: 2,
    stuck_royalty_allocation_projection_samples: [{
      asset_id: "ast_projection_stuck",
      royalty_allocation_status: "verified",
      updated_at: "2026-07-08T10:00:00.000Z",
    }],
    stale_locked_delivery_assets: 1,
    stale_locked_delivery_asset_samples: [{
      asset_id: "ast_delivery_stuck",
      locked_delivery_status: "requested",
      updated_at: "2026-07-08T10:01:00.000Z",
    }],
    failed_story_delivery_assets: 1,
    failed_story_delivery_asset_samples: [{
      asset_id: "ast_failed_wallet",
      story_status: "failed",
      locked_delivery_status: "failed",
      story_error: "Primary wallet is required",
      locked_delivery_error: "Primary wallet is required",
      updated_at: "2026-07-08T10:04:00.000Z",
    }],
    retried_locked_delivery_jobs: 1,
    retried_locked_delivery_job_samples: [{
      job_id: "job_retry",
      asset_id: "ast_retry",
      status: "failed",
      attempt_count: 2,
      last_checkpoint: "story_publish_submitted",
      updated_at: "2026-07-08T10:02:00.000Z",
    }],
    story_registration_reconciliation_required: 1,
    story_registration_reconciliation_samples: [{
      asset_id: "ast_story_unknown",
      status: "reconciliation_required",
      provider_tx_ref: `0x${"ab".repeat(32)}`,
      updated_at: "2026-07-08T10:03:00.000Z",
    }],
    stale_ready_job_lanes: [{
      job_type: "telegram_post_publish",
      ready_jobs: 2,
      oldest_ready_at: "2026-07-08T09:30:00.000Z",
      oldest_ready_age_ms: 30 * 60_000,
    }],
  },
]

describe("ops-alerts emit", () => {
  test("aggregates by code across communities and surfaces listing_creation_failed as high", () => {
    const alerts = buildOpsAlerts(signals)
    const listing = alerts.find((alert) => alert.key === "publish_failure:listing_creation_failed")
    expect(listing).toBeDefined()
    expect(listing?.severity).toBe("high")
    expect(listing?.count).toBe(3)
    expect(listing?.community_ids).toEqual(["c1", "c2"])
    expect(alerts.find((alert) => alert.key === "publish_failure:text_moderation_blocked")).toBeUndefined()
    expect(alerts.find((alert) => alert.key === "terminal_failed_finalize_jobs")?.count).toBe(3)
    expect(alerts.find((alert) => alert.key === "stuck_royalty_allocation_projection_sync")?.severity).toBe("high")
    expect(alerts.find((alert) => alert.key === "stale_locked_delivery_requested_assets")?.count).toBe(1)
    const failedDelivery = alerts.find((alert) => alert.key === "failed_story_or_locked_delivery_assets")
    expect(failedDelivery).toMatchObject({ severity: "high", count: 1, community_ids: ["c2"] })
    expect(JSON.stringify(failedDelivery?.details)).toContain("Primary wallet is required")
    expect(alerts.find((alert) => alert.key === "retried_locked_asset_delivery_jobs")?.severity).toBe("medium")
    expect(alerts.find((alert) => alert.key === "story_registration_reconciliation_required")?.severity).toBe("high")
    expect(alerts.find((alert) => alert.key === "community_job_pickup_stale:telegram_post_publish"))
      .toMatchObject({
        severity: "high",
        count: 2,
        community_ids: ["c2"],
        details: {
          job_type: "telegram_post_publish",
          ready_jobs: 2,
          oldest_ready_age_ms: 30 * 60_000,
        },
      })
  })

  test("dedupe checks without marking, then suppresses only after sent alerts are marked", async () => {
    const deduper = new InMemoryDeduper()
    const alerts = buildOpsAlerts(signals)
    const now = 1_000_000_000_000
    const bucketMs = 60 * 60 * 1000

    const first = await dedupeOpsAlerts({ alerts, deduper, nowMs: now, bucketMs })
    expect(first.length).toBe(alerts.length)
    expect(deduper.marks.length).toBe(0)

    const retryBeforeSend = await dedupeOpsAlerts({ alerts, deduper, nowMs: now + 60_000, bucketMs })
    expect(retryBeforeSend.length).toBe(alerts.length)

    await markOpsAlertsSent({ alerts: first, deduper, nowMs: now, bucketMs })
    expect(deduper.marks.length).toBe(alerts.length)

    const second = await dedupeOpsAlerts({ alerts, deduper, nowMs: now + 60_000, bucketMs })
    expect(second.length).toBe(0)

    const nextBucket = await dedupeOpsAlerts({ alerts, deduper, nowMs: now + bucketMs, bucketMs })
    expect(nextBucket.length).toBe(alerts.length)
  })
})
