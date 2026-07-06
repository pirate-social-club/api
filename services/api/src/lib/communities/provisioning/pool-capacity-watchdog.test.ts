import { describe, expect, spyOn, test } from "bun:test"
import type { Env } from "../../../env"
import { checkScheduledD1PoolCapacity } from "./pool-capacity-watchdog"

function envWithPoolStats(stats: { total: number; allocated: number; free: number; quarantined: number }, threshold?: string): Env {
  return {
    SHARD_ADMIN_TOKEN: "admin-token",
    COMMUNITY_D1_POOL_FREE_ALERT_THRESHOLD: threshold,
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
  test("is a no-op when the shard binding or admin token is missing", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      await checkScheduledD1PoolCapacity({ SHARD_ADMIN_TOKEN: "admin-token" } as Env)
      await checkScheduledD1PoolCapacity({ COMMUNITY_D1_SHARD: {} as Env["COMMUNITY_D1_SHARD"] } as Env)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  test("stays quiet when free capacity is above the threshold", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {})
    try {
      await checkScheduledD1PoolCapacity(envWithPoolStats({ total: 26, allocated: 20, free: 6, quarantined: 0 }, "2"))
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
        "[scheduled] community D1 pool low capacity",
        JSON.stringify({
          total: 26,
          allocated: 26,
          free: 0,
          quarantined: 0,
          threshold: 2,
          urgency: "high",
        }),
      )
    } finally {
      warn.mockRestore()
    }
  })
})
