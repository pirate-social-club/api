import { describe, expect, test } from "bun:test"
import { COMMUNITY_JOB_LANE_TASK, splitScheduledLanes } from "./scheduled-lanes"
import { runScheduledBatch, type CronLock } from "./scheduled-job-runner"

describe("splitScheduledLanes", () => {
  test("puts the community drain in its own lane and everything else in maintenance", () => {
    const lanes = splitScheduledLanes([
      { name: "reconcile_reward_payouts" },
      { name: COMMUNITY_JOB_LANE_TASK },
      { name: "monitor_reward_campaigns" },
    ])
    expect(lanes.community.map((t) => t.name)).toEqual([COMMUNITY_JOB_LANE_TASK])
    expect(lanes.maintenance.map((t) => t.name)).toEqual([
      "reconcile_reward_payouts",
      "monitor_reward_campaigns",
    ])
  })

  test("loses no task and never duplicates one across lanes", () => {
    const names = ["a", COMMUNITY_JOB_LANE_TASK, "b", "c"]
    const lanes = splitScheduledLanes(names.map((name) => ({ name })))
    expect([...lanes.community, ...lanes.maintenance].map((t) => t.name).sort()).toEqual([...names].sort())
  })
})

// A lock that is permanently held by somebody else, i.e. the state a long
// maintenance batch leaves behind when it overruns the cron interval.
function heldLock(): CronLock {
  return { tryAcquire: async () => false, release: async () => undefined }
}

function freeLock(acquisitions: string[], label: string): CronLock {
  return {
    tryAcquire: async () => { acquisitions.push(label); return true },
    release: async () => undefined,
  }
}

describe("scheduler lane isolation", () => {
  // The regression this whole slice exists for: a maintenance task that runs
  // longer than the cron interval used to leave the shared lease held, so the
  // next tick started ZERO community jobs. With per-lane leases the community
  // lane acquires its own and runs regardless.
  test("a slow maintenance lane holding its lease does not stop community jobs starting", async () => {
    const started: string[] = []
    const acquisitions: string[] = []

    // Maintenance lease is held by a still-running previous invocation.
    const maintenance = runScheduledBatch({
      deadlineMs: 30_000,
      leaseTtlMs: 120_000,
      limit: 2,
      lock: heldLock(),
      onLeaseHeld: () => started.push("maintenance:skipped"),
      owner: "tick",
      tasks: [{
        name: "reconcile_reward_campaigns",
        run: async () => { started.push("reconcile_reward_campaigns") },
      }],
    })

    // Community lane has its own lease and must still run.
    const community = runScheduledBatch({
      deadlineMs: 90_000,
      leaseTtlMs: 150_000,
      limit: 1,
      lock: freeLock(acquisitions, "community"),
      owner: "tick",
      tasks: [{
        name: COMMUNITY_JOB_LANE_TASK,
        run: async () => { started.push(COMMUNITY_JOB_LANE_TASK) },
      }],
    })

    const [m, c] = await Promise.all([maintenance, community])

    expect(m.acquired).toBe(false)
    expect(started).toContain("maintenance:skipped")
    // The point of the slice.
    expect(c.acquired).toBe(true)
    expect(started).toContain(COMMUNITY_JOB_LANE_TASK)
    expect(acquisitions).toEqual(["community"])
  })

  test("a maintenance task exceeding 90s does not consume the community lane's budget", async () => {
    const started: string[] = []
    let clock = 0
    const now = () => clock

    // 95s maintenance task: longer than the old shared 90s task deadline and
    // longer than the 60s cron interval.
    const maintenance = runScheduledBatch({
      deadlineMs: 30_000,
      leaseTtlMs: 120_000,
      limit: 1,
      lock: freeLock([], "maintenance"),
      now,
      owner: "tick",
      tasks: [{
        name: "monitor_reward_campaigns",
        run: async () => { clock += 95_000; started.push("monitor_reward_campaigns") },
      }],
    })
    await maintenance

    // The community lane evaluates its own deadline from its own start, so the
    // maintenance overrun above cannot have spent it.
    const communityStart = clock
    const community = await runScheduledBatch({
      deadlineMs: 90_000,
      leaseTtlMs: 150_000,
      limit: 1,
      lock: freeLock([], "community"),
      now: () => clock,
      owner: "tick",
      tasks: [{
        name: COMMUNITY_JOB_LANE_TASK,
        run: async () => { started.push(COMMUNITY_JOB_LANE_TASK) },
      }],
    })

    expect(community.acquired).toBe(true)
    expect(started).toEqual(["monitor_reward_campaigns", COMMUNITY_JOB_LANE_TASK])
    expect(community.result?.skipped ?? []).toEqual([])
    expect(communityStart).toBeGreaterThanOrEqual(95_000)
  })

  test("each lane still refuses to run twice concurrently", async () => {
    // Overlap protection is per lane, not weakened: a lane whose own lease is
    // held starts nothing.
    const started: string[] = []
    const result = await runScheduledBatch({
      deadlineMs: 90_000,
      leaseTtlMs: 150_000,
      limit: 1,
      lock: heldLock(),
      onLeaseHeld: () => started.push("community:skipped"),
      owner: "tick",
      tasks: [{ name: COMMUNITY_JOB_LANE_TASK, run: async () => { started.push("ran") } }],
    })
    expect(result.acquired).toBe(false)
    expect(started).toEqual(["community:skipped"])
    expect(started).not.toContain("ran")
  })
})
