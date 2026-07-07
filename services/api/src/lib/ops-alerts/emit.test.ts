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
  },
  {
    community_id: "c2",
    failure_codes: [
      { code: "listing_creation_failed", count: 1 },
      { code: "internal_error", count: 4 },
      { code: "text_moderation_blocked", count: 9 },
    ],
    terminal_failed_finalize_jobs: 3,
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
