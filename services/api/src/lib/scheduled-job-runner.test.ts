import { describe, expect, test } from "bun:test"

import { runScheduledBatch, runWithConcurrencyLimit, type CronLock, type NamedTask } from "./scheduled-job-runner"
import { evaluateLease, type LeaseRecord } from "./scheduled-cron-lease"

/** In-memory CronLock backed by the SAME pure lease logic as the production DO. */
function fakeLock(): CronLock & { peek: () => LeaseRecord | null } {
  let lease: LeaseRecord | null = null
  return {
    peek: () => lease,
    release: async (owner) => { if (lease && lease.owner === owner) lease = null },
    tryAcquire: async (ttlMs, owner, n) => {
      const decision = evaluateLease(lease, ttlMs, owner, n)
      if (decision.acquired) lease = decision.lease
      return decision.acquired
    },
  }
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** Builds named tasks that track peak concurrency via a shared counter. */
function instrumentedTasks(count: number) {
  const state = { active: 0, peak: 0, ran: [] as string[] }
  const tasks: NamedTask[] = Array.from({ length: count }, (_unused, index) => ({
    name: `job-${index}`,
    run: async () => {
      state.active += 1
      state.peak = Math.max(state.peak, state.active)
      state.ran.push(`job-${index}`)
      await tick()
      state.active -= 1
    },
  }))
  return { state, tasks }
}

describe("runWithConcurrencyLimit", () => {
  test("runs every task exactly once and reports started names", async () => {
    const { state, tasks } = instrumentedTasks(7)
    const result = await runWithConcurrencyLimit(tasks, 2)
    expect(state.ran.length).toBe(7)
    expect(result.started.length).toBe(7)
    expect(result.skipped).toEqual([])
    expect(state.active).toBe(0)
  })

  test("never exceeds the concurrency limit in flight", async () => {
    const { state, tasks } = instrumentedTasks(7)
    await runWithConcurrencyLimit(tasks, 2)
    expect(state.peak).toBe(2)
  })

  test("a higher limit raises peak concurrency proportionally", async () => {
    const { state, tasks } = instrumentedTasks(7)
    await runWithConcurrencyLimit(tasks, 4)
    expect(state.peak).toBe(4)
  })

  test("limit larger than task count runs all at once but no more", async () => {
    const { state, tasks } = instrumentedTasks(3)
    await runWithConcurrencyLimit(tasks, 10)
    expect(state.peak).toBe(3)
    expect(state.ran.length).toBe(3)
  })

  test("a rejecting task does not abort the others; error routed to onError WITH NAME", async () => {
    const errors: { name: string; message: string }[] = []
    const ran: string[] = []
    const tasks: NamedTask[] = ["a", "b", "boomer", "d", "e"].map((name) => ({
      name,
      run: async () => {
        await tick()
        if (name === "boomer") throw new Error(`boom-${name}`)
        ran.push(name)
      },
    }))
    const result = await runWithConcurrencyLimit(tasks, 2, {
      onError: (error, name) => errors.push({ name, message: error instanceof Error ? error.message : String(error) }),
    })
    expect(ran.sort()).toEqual(["a", "b", "d", "e"])
    expect(errors).toEqual([{ name: "boomer", message: "boom-boomer" }])
    expect(result.started.length).toBe(5) // a throwing task still counts as started
  })

  test("empty task list resolves without error and without invoking onError", async () => {
    let called = false
    const result = await runWithConcurrencyLimit([], 2, { onError: () => { called = true } })
    expect(called).toBe(false)
    expect(result).toEqual({ skipped: [], started: [] })
  })

  test("non-positive limit still runs (clamped to 1) rather than hanging", async () => {
    const { state, tasks } = instrumentedTasks(3)
    await runWithConcurrencyLimit(tasks, 0)
    expect(state.ran.length).toBe(3)
    expect(state.peak).toBe(1)
  })

  test("stops starting new tasks past the deadline; reports skipped NAMES", async () => {
    let clock = 1_000
    const now = () => clock
    const ran: string[] = []
    const tasks: NamedTask[] = ["t0", "t1", "t2", "t3", "t4"].map((name) => ({
      name,
      run: async () => { ran.push(name); clock += 100 }, // each task advances the injected clock 100ms
    }))
    const result = await runWithConcurrencyLimit(tasks, 1, { deadlineMs: 250, now })
    expect(ran).toEqual(["t0", "t1", "t2"])
    expect(result.started).toEqual(["t0", "t1", "t2"])
    expect(result.skipped).toEqual(["t3", "t4"]) // deferred names surfaced for telemetry
  })

  test("no deadline runs the whole batch regardless of elapsed time", async () => {
    let clock = 0
    const tasks: NamedTask[] = ["a", "b", "c", "d"].map((name) => ({ name, run: async () => { clock += 10_000 } }))
    const result = await runWithConcurrencyLimit(tasks, 1, { now: () => clock })
    expect(result.skipped).toEqual([])
    expect(result.started.length).toBe(4)
  })
})

describe("runScheduledBatch", () => {
  test("acquires the lease, runs all jobs, then releases it", async () => {
    const lock = fakeLock()
    let ran = 0
    const tasks: NamedTask[] = [
      { name: "j1", run: async () => { ran += 1 } },
      { name: "j2", run: async () => { ran += 1 } },
    ]
    const out = await runScheduledBatch({ leaseTtlMs: 60_000, limit: 2, lock, owner: "A", tasks })
    expect(out.acquired).toBe(true)
    expect(ran).toBe(2)
    expect(out.result?.started.length).toBe(2)
    expect(lock.peek()).toBeNull() // released in finally
  })

  test("OVERLAP: invocation B cannot acquire while A holds the lease, and starts ZERO jobs", async () => {
    const lock = fakeLock()
    let releaseA: () => void = () => {}
    const aBlocked = new Promise<void>((resolve) => { releaseA = resolve })
    let aJobRuns = 0
    let bJobRuns = 0

    // Invocation A: acquires, starts a long in-flight job (parked on aBlocked).
    const aPromise = runScheduledBatch({
      leaseTtlMs: 60_000,
      limit: 1,
      lock,
      owner: "A",
      tasks: [{ name: "a-long-job", run: async () => { aJobRuns += 1; await aBlocked } }],
    })
    await tick() // let A acquire the lease and enter its long job
    expect(aJobRuns).toBe(1)
    expect(lock.peek()?.owner).toBe("A")

    // Invocation B fires BEFORE A finishes → fails to acquire → starts zero jobs.
    let bLeaseHeld = false
    const bOut = await runScheduledBatch({
      leaseTtlMs: 60_000,
      limit: 1,
      lock,
      onLeaseHeld: () => { bLeaseHeld = true },
      owner: "B",
      tasks: [{ name: "b-job", run: async () => { bJobRuns += 1 } }],
    })
    expect(bOut.acquired).toBe(false)
    expect(bOut.result).toBeNull()
    expect(bJobRuns).toBe(0) // ← the core guarantee: B started no jobs
    expect(bLeaseHeld).toBe(true)

    // A finishes and releases; the lease is now free for a later invocation.
    releaseA()
    await aPromise
    expect(lock.peek()).toBeNull()
  })

  test("releases the lease even if a job throws", async () => {
    const lock = fakeLock()
    const out = await runScheduledBatch({
      leaseTtlMs: 60_000,
      limit: 1,
      lock,
      onError: () => {},
      owner: "A",
      tasks: [{ name: "boom", run: async () => { throw new Error("x") } }],
    })
    expect(out.acquired).toBe(true)
    expect(lock.peek()).toBeNull()
  })
})
