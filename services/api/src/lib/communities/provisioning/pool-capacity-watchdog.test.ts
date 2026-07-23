import { describe, expect, spyOn, test } from "bun:test"
import type { Env } from "../../../env"
import {
  checkScheduledD1PoolCapacity,
  classifyD1PoolCapacity,
  parseExhaustionAlertHours,
  parseFreeAlertThreshold,
} from "./pool-capacity-watchdog"

type PoolStats = {
  total: number
  allocated: number
  free: number
  quarantined: number
  allocatedLast24Hours?: number
  allocatedLast7Days?: number
}

function envWithPoolStats(
  stats: PoolStats,
  threshold?: string,
  exhaustionAlertHours?: string,
): Env {
  return {
    SHARD_ADMIN_TOKEN: "admin-token",
    COMMUNITY_D1_POOL_FREE_ALERT_THRESHOLD: threshold,
    COMMUNITY_D1_POOL_EXHAUSTION_ALERT_HOURS: exhaustionAlertHours,
    COMMUNITY_D1_SHARD: {
      communityD1PoolStats: async (input: { adminToken: string }) => ({
        ok: true as const,
        value: stats,
        input,
      }),
    } as unknown as Env["COMMUNITY_D1_SHARD"],
  } as Env
}

describe("checkScheduledD1PoolCapacity", () => {
  test("is a no-op when the shard binding is missing", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      await checkScheduledD1PoolCapacity({ SHARD_ADMIN_TOKEN: "admin-token" } as Env)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  test("warns when the shard binding exists but the admin token is missing", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      await checkScheduledD1PoolCapacity({ COMMUNITY_D1_SHARD: {} as Env["COMMUNITY_D1_SHARD"] } as Env)
      expect(warn).toHaveBeenCalledWith("[scheduled] pool watchdog misconfigured: shard bound, no admin token")
    } finally {
      warn.mockRestore()
    }
  })

  test("stays quiet when free capacity is above the threshold", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      await checkScheduledD1PoolCapacity(envWithPoolStats({
        total: 26,
        allocated: 20,
        free: 6,
        quarantined: 0,
        allocatedLast24Hours: 1,
        allocatedLast7Days: 1,
      }, "2"))
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  test("warns when free capacity is at or below the threshold", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      await checkScheduledD1PoolCapacity(envWithPoolStats({ total: 26, allocated: 26, free: 0, quarantined: 0 }, "2"))
      expect(warn).toHaveBeenCalledWith(
        "[scheduled] community D1 pool capacity warning",
        JSON.stringify({
          total: 26,
          allocated: 26,
          free: 0,
          quarantined: 0,
          threshold: 2,
          exhaustionAlertHours: 72,
          burnRatePerHour: null,
          forecastCapacity: 0,
          hoursToExhaustion: null,
          urgency: "high",
        }),
      )
    } finally {
      warn.mockRestore()
    }
  })

  test("warns before the fixed threshold when recent burn predicts exhaustion", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      await checkScheduledD1PoolCapacity(envWithPoolStats({
        total: 944,
        allocated: 651,
        free: 293,
        quarantined: 0,
        allocatedLast24Hours: 120,
        allocatedLast7Days: 441,
      }, "8", "72"))
      expect(warn).toHaveBeenCalledWith(
        "[scheduled] community D1 pool capacity warning",
        JSON.stringify({
          total: 944,
          allocated: 651,
          free: 293,
          quarantined: 0,
          allocatedLast24Hours: 120,
          allocatedLast7Days: 441,
          threshold: 8,
          exhaustionAlertHours: 72,
          burnRatePerHour: 5,
          forecastCapacity: 293,
          hoursToExhaustion: 58.6,
          urgency: "normal",
        }),
      )
    } finally {
      warn.mockRestore()
    }
  })

  test("keeps the legacy level check when the deployed shard lacks burn fields", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      await checkScheduledD1PoolCapacity(
        envWithPoolStats({ total: 26, allocated: 20, free: 6, quarantined: 0 }, "2", "72"),
      )
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

describe("D1 pool capacity classification", () => {
  test("uses the configured threshold and requires free capacity above it", () => {
    expect(classifyD1PoolCapacity({ total: 30, allocated: 21, free: 9, quarantined: 0 }, "8")).toEqual({
      total: 30,
      allocated: 21,
      free: 9,
      quarantined: 0,
      threshold: 8,
      exhaustionAlertHours: 72,
      burnRatePerHour: null,
      forecastCapacity: 9,
      hoursToExhaustion: null,
      exhaustionImminent: false,
      healthy: true,
    })
    expect(classifyD1PoolCapacity({ total: 30, allocated: 22, free: 8, quarantined: 0 }, "8").healthy).toBe(false)
  })

  test("falls back safely when the threshold is invalid", () => {
    expect(parseFreeAlertThreshold("not-a-number")).toBe(2)
    expect(parseFreeAlertThreshold("-1")).toBe(2)
    expect(parseExhaustionAlertHours("not-a-number")).toBe(72)
    expect(parseExhaustionAlertHours("-1")).toBe(72)
  })

  test("uses the faster of the 24-hour and 7-day burn windows", () => {
    expect(classifyD1PoolCapacity({
      total: 944,
      allocated: 651,
      free: 293,
      quarantined: 0,
      allocatedLast24Hours: 61,
      allocatedLast7Days: 441,
    }, "8", "120")).toMatchObject({
      burnRatePerHour: 2.625,
      forecastCapacity: 293,
      hoursToExhaustion: 111.6,
      exhaustionAlertHours: 120,
      exhaustionImminent: true,
      healthy: true,
    })
  })

  test("counts five-minute quarantine capacity in the longer exhaustion forecast", () => {
    expect(classifyD1PoolCapacity({
      total: 30,
      allocated: 20,
      free: 8,
      quarantined: 2,
      allocatedLast24Hours: 24,
      allocatedLast7Days: 70,
    }, "2", "9")).toMatchObject({
      burnRatePerHour: 1,
      forecastCapacity: 10,
      hoursToExhaustion: 10,
      exhaustionImminent: false,
    })
  })
})
