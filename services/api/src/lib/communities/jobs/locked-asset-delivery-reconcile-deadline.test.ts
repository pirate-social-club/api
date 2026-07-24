import { describe, expect, it } from "bun:test"
import { reconcileRequestedLockedAssetDeliveryJobs } from "./locked-asset-delivery-handler"
import type { Env } from "../../../env"
import type { CommunityJobRepository } from "./runner-types"

// The prelude deadline governs how many communities a reconcile STARTS; it
// never interrupts one already scanning. An empty repository makes every start
// fail fast, so the reconcile's own checked/deferred counts are what these
// assert.
const repository = {} as CommunityJobRepository
const env = {} as Env

function listRepository(communityIds: string[]): CommunityJobRepository {
  return {
    listActiveCommunities: async () => communityIds.map((community_id) => ({ community_id })),
  } as unknown as CommunityJobRepository
}

describe("reconcileRequestedLockedAssetDeliveryJobs prelude deadline", () => {
  it("checks every community when no deadline is configured", async () => {
    const summary = await reconcileRequestedLockedAssetDeliveryJobs({
      env,
      communityRepository: repository,
      communityIds: ["cmt_1", "cmt_2", "cmt_3"],
      deadlineAtMs: null,
    })

    expect(summary.checked_communities).toBe(3)
    expect(summary.deferred_communities).toBe(0)
  })

  it("starts no community when the deadline is already spent", async () => {
    let observations = 0
    const summary = await reconcileRequestedLockedAssetDeliveryJobs({
      env,
      communityRepository: repository,
      communityIds: ["cmt_1", "cmt_2", "cmt_3"],
      deadlineAtMs: 1,
      nowMs: () => (observations++ === 0 ? 0 : 10_000_000),
    })

    expect(summary.checked_communities).toBe(0)
    expect(summary.deferred_communities).toBe(3)
    expect(summary.enqueued_jobs).toBe(0)
  })

  it("defers the remaining communities once the deadline passes", async () => {
    // Each clock observation advances 20s, so a 45s budget runs out partway
    // through the list instead of walking all five communities.
    let clock = 0
    const summary = await reconcileRequestedLockedAssetDeliveryJobs({
      env,
      communityRepository: repository,
      communityIds: ["cmt_1", "cmt_2", "cmt_3", "cmt_4", "cmt_5"],
      deadlineAtMs: 45_000,
      nowMs: () => {
        const value = clock
        clock += 20_000
        return value
      },
    })

    expect(summary.checked_communities).toBeGreaterThan(0)
    expect(summary.checked_communities).toBeLessThan(5)
    expect(summary.checked_communities + summary.deferred_communities).toBe(5)
  })

  it("rotates the scan order so consecutive truncated ticks cover different communities", async () => {
    // One 10s step per clock observation against a 15s budget scans exactly one
    // community per tick; rotation moves the next tick's start past it.
    const runTick = (minuteMs: number) => {
      let clock = minuteMs
      return reconcileRequestedLockedAssetDeliveryJobs({
        env,
        communityRepository: listRepository(["cmt_1", "cmt_2", "cmt_3"]),
        deadlineAtMs: minuteMs + 15_000,
        nowMs: () => {
          const value = clock
          clock += 10_000
          return value
        },
      })
    }

    const firstTick = await runTick(0)
    const secondTick = await runTick(60_000)

    expect(firstTick.checked_communities).toBe(1)
    expect(secondTick.checked_communities).toBe(1)
    // Every start fails fast against the empty repository, so the failure list
    // records the scan order.
    expect(firstTick.failed_communities[0]?.community_id).toBe("cmt_1")
    expect(secondTick.failed_communities[0]?.community_id).toBe("cmt_2")
  })
})
