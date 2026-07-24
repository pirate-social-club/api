import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, unlinkSync } from "node:fs"
import crypto from "node:crypto"
import { createClient } from "@libsql/client"
import { runOpsAlerts } from "./run"
import type { Env } from "../../env"
import type { CommunityJobRepository } from "../communities/jobs/runner-types"

// The scan deadline governs how many communities a pass STARTS; it never
// interrupts one already scanning. An empty repository makes every start fail
// fast (the failure is caught and logged per community), so the pass's own
// scanned/deferred counts are what these assert. The refund-review query runs
// against a real empty sqlite file because runOpsAlerts owns its control-plane
// client; the missing table error is caught inside the pass.
const dbPath = `/tmp/ops-alerts-scan-deadline-${crypto.randomUUID()}.sqlite`
const env = {
  OPS_ALERT_DEDUPE: {},
  CONTROL_PLANE_DATABASE_URL: `file:${dbPath}`,
} as unknown as Env

afterEach(async () => {
  const client = createClient({ url: `file:${dbPath}` })
  client.close()
  if (existsSync(dbPath)) {
    unlinkSync(dbPath)
  }
})

function listRepository(communityIds: string[]): CommunityJobRepository {
  return {
    listActiveCommunities: async () => communityIds.map((community_id) => ({ community_id })),
  } as unknown as CommunityJobRepository
}

describe("runOpsAlerts scan deadline", () => {
  it("scans every selected community when no deadline is configured", async () => {
    const summary = await runOpsAlerts({
      env,
      communityRepository: listRepository(["cmt_1", "cmt_2", "cmt_3"]),
      nowMs: 0,
      deadlineAtMs: null,
    })

    expect(summary.scanned_communities).toBe(3)
    expect(summary.deferred_communities).toBe(0)
  })

  it("starts no community when the deadline is already spent", async () => {
    let observations = 0
    const summary = await runOpsAlerts({
      env,
      communityRepository: listRepository(["cmt_1", "cmt_2", "cmt_3"]),
      nowMs: 0,
      deadlineAtMs: 1,
      now: () => (observations++ === 0 ? 0 : 10_000_000),
    })

    expect(summary.scanned_communities).toBe(0)
    expect(summary.deferred_communities).toBe(3)
  })

  it("defers the remaining communities once the deadline passes", async () => {
    // Each clock observation advances 20s, so a 45s budget runs out partway
    // through the list instead of walking all five communities.
    let clock = 0
    const summary = await runOpsAlerts({
      env,
      communityRepository: listRepository(["cmt_1", "cmt_2", "cmt_3", "cmt_4", "cmt_5"]),
      nowMs: 0,
      deadlineAtMs: 45_000,
      now: () => {
        const value = clock
        clock += 20_000
        return value
      },
    })

    expect(summary.scanned_communities).toBeGreaterThan(0)
    expect(summary.scanned_communities).toBeLessThan(5)
    expect(summary.scanned_communities + summary.deferred_communities).toBe(5)
  })
})
