import { describe, expect, it } from "bun:test"
import { processAvailableCommunityJobs } from "./runner"
import type { Env } from "../../../env"
import type { CommunityJobRepository } from "./runner-types"

// The tick deadline governs how many communities a single tick STARTS; it never
// interrupts one already draining. An empty repository makes every start fail
// fast, so the tick's own started/deferred counts are what these assert.
const repository = {} as CommunityJobRepository
const env = {} as Env

function runTick(options: {
  communityIds: string[]
  deadlineMs?: number | null
  now?: () => number
}) {
  return processAvailableCommunityJobs({
    env,
    communityRepository: repository,
    communityIds: options.communityIds,
    deadlineMs: options.deadlineMs,
    now: options.now,
  })
}

describe("processAvailableCommunityJobs tick deadline", () => {
  it("starts every community when no deadline is configured", async () => {
    const summary = await runTick({
      communityIds: ["cmt_1", "cmt_2", "cmt_3"],
      deadlineMs: null,
    })

    expect(summary.started_communities).toBe(3)
    expect(summary.deferred_communities).toBe(0)
  })

  it("defers the remaining communities once the deadline passes", async () => {
    // Each clock observation advances 20s, so a 45s budget runs out partway
    // through the list instead of walking all five communities.
    let clock = 0
    const summary = await runTick({
      communityIds: ["cmt_1", "cmt_2", "cmt_3", "cmt_4", "cmt_5"],
      deadlineMs: 45_000,
      now: () => {
        const value = clock
        clock += 20_000
        return value
      },
    })

    expect(summary.started_communities).toBeGreaterThan(0)
    expect(summary.started_communities).toBeLessThan(5)
    expect(summary.started_communities + summary.deferred_communities).toBe(5)
  })

  it("always starts one community even when the budget is already spent", async () => {
    // The tick starts at t=0 and the very first community exhausts the budget.
    let observations = 0
    const summary = await runTick({
      communityIds: ["cmt_1", "cmt_2", "cmt_3"],
      deadlineMs: 1,
      now: () => (observations++ === 0 ? 0 : 10_000_000),
    })

    expect(summary.started_communities).toBe(1)
    expect(summary.deferred_communities).toBe(2)
  })
})
