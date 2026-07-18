import { describe, expect, test } from "bun:test"
import type { Env } from "../../env"
import { opsAlertBucketMs, opsAlertDedupeTtlSeconds } from "./policy"

const HOUR_MS = 60 * 60 * 1000

describe("ops alert reminder policy", () => {
  test("uses four-hour production high reminders and daily lower-severity reminders", () => {
    const env = { ENVIRONMENT: "production" } as Env
    expect(opsAlertBucketMs(env, "high")).toBe(4 * HOUR_MS)
    expect(opsAlertBucketMs(env, "medium")).toBe(24 * HOUR_MS)
    expect(opsAlertBucketMs(env, "low")).toBe(24 * HOUR_MS)
  })

  test("uses daily staging reminders even for high alerts", () => {
    expect(opsAlertBucketMs({ ENVIRONMENT: "staging" } as Env, "high")).toBe(24 * HOUR_MS)
  })

  test("honors severity-specific and legacy high bucket overrides", () => {
    expect(opsAlertBucketMs({
      ENVIRONMENT: "staging",
      OPS_ALERT_HIGH_BUCKET_MS: String(2 * HOUR_MS),
      OPS_ALERT_MEDIUM_BUCKET_MS: String(8 * HOUR_MS),
      OPS_ALERT_LOW_BUCKET_MS: String(12 * HOUR_MS),
    } as Env, "high")).toBe(2 * HOUR_MS)
    expect(opsAlertBucketMs({ OPS_ALERT_BUCKET_MS: String(3 * HOUR_MS) } as Env, "high")).toBe(3 * HOUR_MS)
  })

  test("keeps dedupe keys alive for two full reminder buckets", () => {
    expect(opsAlertDedupeTtlSeconds(24 * HOUR_MS)).toBe(48 * 60 * 60)
  })
})
