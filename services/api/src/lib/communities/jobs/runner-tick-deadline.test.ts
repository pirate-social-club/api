import { describe, expect, it } from "bun:test"
import {
  processAvailableCommunityJobs,
  processCommunityJobsForCommunity,
  rotateCommunityJobTickIds,
} from "./runner"
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
  sweepDeadlineMs?: number | null
  maxCommunities?: number
  now?: () => number
}) {
  return processAvailableCommunityJobs({
    env,
    communityRepository: repository,
    communityIds: options.communityIds,
    deadlineMs: options.deadlineMs,
    sweepDeadlineMs: options.sweepDeadlineMs,
    maxCommunities: options.maxCommunities,
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
    expect(summary.swept_communities).toBe(3)
    expect(summary.deferred_sweep_communities).toBe(0)
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

    expect(summary.swept_communities).toBeGreaterThan(0)
    expect(summary.swept_communities).toBeLessThan(5)
    expect(summary.swept_communities + summary.deferred_sweep_communities).toBe(5)
    expect(summary.started_communities).toBe(0)
    expect(summary.started_communities + summary.deferred_communities).toBe(5)
  })

  it("starts no processing work when the stale sweep spends the budget", async () => {
    // The tick starts at t=0 and the first sweep deadline check sees the budget
    // already spent. Returning immediately lets later scheduled jobs run.
    let observations = 0
    const summary = await runTick({
      communityIds: ["cmt_1", "cmt_2", "cmt_3"],
      deadlineMs: 1,
      now: () => (observations++ === 0 ? 0 : 10_000_000),
    })

    expect(summary.swept_communities).toBe(0)
    expect(summary.deferred_sweep_communities).toBe(3)
    expect(summary.started_communities).toBe(0)
    expect(summary.deferred_communities).toBe(3)
    expect(summary.processed_jobs).toBe(0)
  })

  it("does not start another job after the per-job budget expires", async () => {
    const summary = await processCommunityJobsForCommunity({
      env,
      communityId: "cmt_1",
      communityRepository: repository,
      deadlineAtMs: 100,
      now: () => 100,
    })

    expect(summary.processed_jobs).toBe(0)
  })

  it("reserves processing time when the stale sweep reaches its phase budget", async () => {
    let clock = 0
    const summary = await runTick({
      communityIds: ["cmt_1", "cmt_2", "cmt_3"],
      deadlineMs: 45_000,
      sweepDeadlineMs: 15_000,
      now: () => {
        const value = clock
        clock += 5_000
        return value
      },
    })

    expect(summary.swept_communities).toBe(1)
    expect(summary.deferred_sweep_communities).toBe(2)
    // Processing is NOT limited to the swept community. The sweep hitting its
    // phase budget hands the rest of the tick to job work, which then walks the
    // selected list until the batch deadline stops it.
    expect(summary.started_communities).toBeGreaterThan(summary.swept_communities)
    expect(summary.sweep_ms).toBeGreaterThanOrEqual(15_000)
    expect(summary.process_ms).toBeGreaterThan(0)
  })

  // Regression: job execution used to iterate the stale sweep's output, so a
  // truncated sweep silently capped how many communities could run jobs at all.
  // On staging (~950 routed communities) the sweep reached ten per tick, so a
  // queued job outside that subset waited hours behind maintenance work.
  it("starts jobs for communities the stale sweep never reached", async () => {
    const communityIds = Array.from({ length: 300 }, (_, index) => `cmt_${String(index).padStart(3, "0")}`)
    // The clock jumps once and then holds, so the outcome does not depend on how
    // many times the runner samples it: the sweep budget is provably spent while
    // the batch deadline is provably not. A per-call increment made this depend
    // on internal call counts and failed under CI while passing locally.
    let calls = 0
    const summary = await runTick({
      communityIds,
      // The default cap is 100; this fleet-scale case selects all of them.
      maxCommunities: communityIds.length,
      deadlineMs: 10_000_000,
      sweepDeadlineMs: 100,
      now: () => (calls++ < 3 ? 0 : 1_000),
    })

    // The sweep reached only a handful, and deferred the overwhelming majority.
    expect(summary.swept_communities).toBeLessThan(20)
    expect(summary.deferred_sweep_communities).toBeGreaterThan(280)
    // Yet every selected community is still started for job work. This is the
    // regression signal: under the old coupling started_communities could never
    // exceed swept_communities, so this was ~5 rather than 300.
    expect(summary.started_communities).toBe(communityIds.length)
    expect(summary.deferred_communities).toBe(0)
    expect(summary.started_communities).toBeGreaterThan(summary.swept_communities * 10)
  })

  it("rotates the front of a fully selected poll so truncated sweeps stay fair", () => {
    const communityIds = ["cmt_1", "cmt_2", "cmt_3"]
    expect(rotateCommunityJobTickIds(communityIds, 0)).toEqual([
      "cmt_1",
      "cmt_2",
      "cmt_3",
    ])
    expect(rotateCommunityJobTickIds(communityIds, 60_000)).toEqual([
      "cmt_2",
      "cmt_3",
      "cmt_1",
    ])
  })
})
