import { describe, expect, it } from "bun:test"
import { communityJobTimings } from "./runner"

describe("communityJobTimings", () => {
  it("measures pickup latency from available_at, not created_at, on a retry", () => {
    // The retry case is the whole point. A job enqueued at 10:00 whose first
    // attempt ran and failed at 10:05 backs off to 10:05:30. If it is claimed at
    // 10:06, the scheduler kept it waiting 30s — NOT six minutes. Measuring from
    // created_at would fold the previous attempt's execution and its backoff into
    // a "scheduler wait" number and badly overstate scheduler latency.
    const timings = communityJobTimings(
      { created_at: "2026-07-22T10:00:00.000Z", available_at: "2026-07-22T10:05:30.000Z" },
      "2026-07-22T10:06:00.000Z",
    )

    expect(timings.pickup_latency_ms).toBe(30_000)
    expect(timings.job_age_at_attempt_start_ms).toBe(360_000)
  })

  it("falls back to created_at when the job was runnable the moment it was enqueued", () => {
    const timings = communityJobTimings(
      { created_at: "2026-07-22T10:00:00.000Z", available_at: null },
      "2026-07-22T10:02:00.000Z",
    )

    expect(timings.pickup_latency_ms).toBe(120_000)
    expect(timings.job_age_at_attempt_start_ms).toBe(120_000)
  })

  it("clamps a job claimed before its available_at to zero rather than reporting negative wait", () => {
    const timings = communityJobTimings(
      { created_at: "2026-07-22T10:00:00.000Z", available_at: "2026-07-22T10:10:00.000Z" },
      "2026-07-22T10:05:00.000Z",
    )

    expect(timings.pickup_latency_ms).toBe(0)
  })

  it("reports null rather than NaN for unparseable timestamps", () => {
    const timings = communityJobTimings(
      { created_at: "not-a-date", available_at: "also-not-a-date" },
      "2026-07-22T10:00:00.000Z",
    )

    expect(timings.pickup_latency_ms).toBeNull()
    expect(timings.job_age_at_attempt_start_ms).toBeNull()
  })
})
