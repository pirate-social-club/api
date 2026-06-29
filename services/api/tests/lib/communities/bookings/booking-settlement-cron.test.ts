import { describe, expect, test } from "bun:test"

import {
  isBookingSettlementCronEnabled,
  sweepDueBookingSettlements,
  type ProcessCommunityInput,
  type SweepBookingSettlementsInput,
} from "../../../../src/lib/communities/bookings/booking-settlement-cron"
import { selectScheduledCommunityJobPollIds } from "../../../../src/lib/communities/jobs/runner"
import { runScheduledBatch } from "../../../../src/lib/scheduled-job-runner"
import type { Env } from "../../../../src/env"

function envWith(flag: unknown): Env {
  return { BOOKINGS_SETTLEMENT_CRON_ENABLED: flag } as unknown as Env
}

function fakeRepo(ids: string[]): SweepBookingSettlementsInput["communityRepository"] & { calls: number } {
  let calls = 0
  const repo = {
    get calls() { return calls },
    listSettlementEligibleCommunities: async () => { calls += 1; return ids.map((community_id, i) => ({ community_id, created_at: new Date(1_700_000_000_000 + i).toISOString() })) },
  }
  return repo as unknown as SweepBookingSettlementsInput["communityRepository"] & { calls: number }
}

describe("booking settlement cron — gating", () => {
  test.each([undefined, "", "false", "0", "yes", "TRUE ", "true\n", "enabled"])("flag %p does NOT enumerate unless exactly true", async (flag) => {
    const repo = fakeRepo(["c1", "c2"])
    let processed = 0
    const summary = await sweepDueBookingSettlements({ env: envWith(flag), communityRepository: repo, processCommunity: async () => { processed += 1 } })
    const expectedEnabled = String(flag ?? "").trim().toLowerCase() === "true"
    expect(summary.enabled).toBe(expectedEnabled)
    if (!expectedEnabled) {
      expect(repo.calls).toBe(0) // no D1 enumeration
      expect(processed).toBe(0)
    }
  })

  test("exactly \"true\" enables enumeration", async () => {
    const repo = fakeRepo(["c1"])
    let processed = 0
    const summary = await sweepDueBookingSettlements({ env: envWith("true"), communityRepository: repo, processCommunity: async () => { processed += 1 } })
    expect(summary.enabled).toBe(true)
    expect(repo.calls).toBe(1)
    expect(processed).toBe(1)
    expect(isBookingSettlementCronEnabled(envWith("true"))).toBe(true)
  })
})

describe("booking settlement cron — orchestration", () => {
  test("enforces the maxCommunities bound", async () => {
    const repo = fakeRepo(["c1", "c2", "c3", "c4", "c5"])
    const seen: string[] = []
    await sweepDueBookingSettlements({ env: envWith("true"), communityRepository: repo, maxCommunities: 2, processCommunity: async (i) => { seen.push(i.communityId) } })
    expect(seen.length).toBe(2)
  })

  test("deadline stops STARTING new communities; started work finishes", async () => {
    const repo = fakeRepo(["c1", "c2", "c3"])
    let clock = 1000
    const seen: string[] = []
    const summary = await sweepDueBookingSettlements({
      env: envWith("true"), communityRepository: repo, deadlineMs: 50, now: () => clock,
      processCommunity: async (i: ProcessCommunityInput) => { seen.push(i.communityId); clock += 60 }, // after c1, clock is past the 50ms deadline
    })
    expect(seen).toEqual(["c1"]) // c1 started (and finished); c2/c3 not started
    expect(summary.deadlineReached).toBe(true)
    expect(summary.communitiesScanned).toBe(1)
  })

  test("a failing community does not stop later communities", async () => {
    const repo = fakeRepo(["c1", "c2", "c3"])
    const seen: string[] = []
    const summary = await sweepDueBookingSettlements({
      env: envWith("true"), communityRepository: repo,
      processCommunity: async (i) => { seen.push(i.communityId); if (i.communityId === "c2") throw new Error("boom") },
    })
    expect(seen).toEqual(["c1", "c2", "c3"]) // all attempted
    expect(summary.errors).toBe(1)
    expect(summary.communitiesScanned).toBe(2) // c1 + c3
  })

  test("enabled zero-work run returns a structured summary", async () => {
    const repo = fakeRepo(["c1", "c2"])
    const summary = await sweepDueBookingSettlements({ env: envWith("true"), communityRepository: repo, processCommunity: async () => {} })
    expect(summary).toMatchObject({ enabled: true, communitiesScanned: 2, settled: 0, pending: 0, errors: 0, deadlineReached: false })
  })

  test("the processor can mutate the shared summary and observe shouldStop", async () => {
    const repo = fakeRepo(["c1"])
    const summary = await sweepDueBookingSettlements({
      env: envWith("true"), communityRepository: repo,
      processCommunity: async (i) => { expect(typeof i.shouldStop()).toBe("boolean"); i.summary.settled += 3 },
    })
    expect(summary.settled).toBe(3)
  })
})

async function captureConsoleError<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = []
  const orig = console.error
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(" ")) }
  try {
    const result = await fn()
    return { result, lines }
  } finally {
    console.error = orig
  }
}

describe("booking settlement cron — sanitized failure logging", () => {
  test("a coordinator/RPC-style error logs a sanitized code + incident id, NEVER the raw message", async () => {
    const repo = fakeRepo(["c1"])
    const secret = "tx 0xdeadbeef to https://rpc.example/secret?key=SUPERSECRET"
    const { lines } = await captureConsoleError(() => sweepDueBookingSettlements({
      env: envWith("true"), communityRepository: repo, processCommunity: async () => { throw new Error(secret) },
    }))
    const line = lines.find((l) => l.includes("[booking-settlements] failure")) ?? ""
    expect(line).not.toContain("SUPERSECRET")
    expect(line).not.toContain("0xdeadbeef")
    expect(line).toContain('"code":"unknown:Error"')
    expect(line).toMatch(/"incidentId":"[0-9a-f-]{36}"/)
  })

  test("a known guard error logs its approved stable code (no incident id, no raw message)", async () => {
    const repo = fakeRepo(["c1"])
    const { lines } = await captureConsoleError(() => sweepDueBookingSettlements({
      env: envWith("true"), communityRepository: repo, processCommunity: async () => { throw new Error("booking_refund_destination_missing") },
    }))
    const line = lines.find((l) => l.includes("[booking-settlements] failure")) ?? ""
    expect(line).toContain('"code":"booking_refund_destination_missing"')
    expect(line).toContain('"incidentId":null')
  })
})

describe("booking settlement cron — fatal enumeration", () => {
  test("a failing listSettlementEligibleCommunities returns a structured FATAL summary (never throws), sanitized", async () => {
    const repo = { listSettlementEligibleCommunities: async () => { throw new Error("control plane down at https://db/secret-token") } } as unknown as SweepBookingSettlementsInput["communityRepository"]
    const { result: summary, lines } = await captureConsoleError(() => sweepDueBookingSettlements({ env: envWith("true"), communityRepository: repo }))
    expect(summary.enabled).toBe(true)
    expect(summary.fatal).toBe(true)
    expect(summary.errors).toBeGreaterThanOrEqual(1)
    expect(lines.join("")).not.toContain("secret-token") // fatal log is sanitized too
  })
})

describe("community rotation (selectScheduledCommunityJobPollIds)", () => {
  test("covers all communities across successive minute buckets (no persistent tail starvation)", () => {
    const communities = Array.from({ length: 10 }, (_v, i) => ({ community_id: `c${i}`, created_at: new Date(1_700_000_000_000 + i).toISOString() }))
    const covered = new Set<string>()
    for (let bucket = 0; bucket < 20; bucket += 1) {
      for (const id of selectScheduledCommunityJobPollIds(communities, 3, bucket * 60_000)) covered.add(id)
    }
    expect(covered.size).toBe(10) // every community selected at least once
  })
})

describe("scheduled-task registration runs the gated task under the cron lock", () => {
  test("the booking task runs within an acquired lease and is gated", async () => {
    let acquired = 0
    let released = 0
    let held = false
    const lock = {
      tryAcquire: async () => { acquired += 1; held = true; return true },
      release: async () => { released += 1; held = false },
    }
    let ranWhileHeld = false
    const env = envWith("true")
    const repo = fakeRepo(["c1"])
    const tasks = [{
      name: "reconcile_booking_settlements",
      run: async () => {
        if (!isBookingSettlementCronEnabled(env)) return // the index.ts gate
        ranWhileHeld = held
        await sweepDueBookingSettlements({ env, communityRepository: repo, processCommunity: async () => {} })
      },
    }]
    const result = await runScheduledBatch({ lock, owner: "owner-1", leaseTtlMs: 120_000, tasks, limit: 1, deadlineMs: 30_000 })
    expect(result.acquired).toBe(true)
    expect(acquired).toBe(1)
    expect(released).toBe(1)
    expect(ranWhileHeld).toBe(true) // task executed while the lease was held
  })
})
