import { describe, expect, test } from "bun:test"

import { runRewardCampaignMonitorCycle } from "./reward-campaign-monitor-cycle"

describe("reward campaign monitor cycle", () => {
  test("runs the integrity monitor after funding reconciliation fails", async () => {
    const events: string[] = []
    const summary = await runRewardCampaignMonitorCycle({
      reconcileFunding: async () => {
        events.push("funding")
        throw new Error("candidate query unavailable")
      },
      onFundingError: async (error) => {
        events.push(`funding-error:${error instanceof Error ? error.message : "unknown"}`)
      },
      monitorIntegrity: async () => {
        events.push("integrity")
        return { enabled: true }
      },
    })

    expect(events).toEqual([
      "funding",
      "funding-error:candidate query unavailable",
      "integrity",
    ])
    expect(summary).toEqual({ enabled: true })
  })

  test("runs the integrity monitor when funding error reporting also fails", async () => {
    let integrityRuns = 0
    const originalError = console.error
    console.error = () => undefined
    try {
      await runRewardCampaignMonitorCycle({
        reconcileFunding: async () => {
          throw new Error("candidate query unavailable")
        },
        onFundingError: async () => {
          throw new Error("alert transport unavailable")
        },
        monitorIntegrity: async () => {
          integrityRuns += 1
        },
      })
    } finally {
      console.error = originalError
    }

    expect(integrityRuns).toBe(1)
  })
})
