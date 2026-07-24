import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, unlinkSync } from "node:fs"
import crypto from "node:crypto"
import { createClient } from "@libsql/client"
import { reconcileStaleSongArtifactUploadSessionJobs } from "./song-artifact-session-reaper-handler"
import type { Env } from "../../../env"
import type { CommunityJobRepository } from "./runner-types"

// The prelude deadline governs how many communities a reconcile STARTS; it
// never interrupts one already scanning. An empty community repository makes
// every per-community start fail fast, so the reconcile's own checked/deferred
// counts are what these assert. The control-plane query runs against a real
// per-test sqlite file because the reconcile owns its control-plane client.
const repository = {} as CommunityJobRepository
const dbPaths: string[] = []

afterEach(() => {
  for (const path of dbPaths.splice(0)) {
    if (existsSync(path)) {
      unlinkSync(path)
    }
  }
})

async function createControlPlane(communityIds: string[]): Promise<Env> {
  const path = `/tmp/song-artifact-session-reaper-deadline-${crypto.randomUUID()}.sqlite`
  dbPaths.push(path)
  const client = createClient({ url: `file:${path}` })
  try {
    await client.execute(`
      CREATE TABLE song_artifact_upload_sessions (
        community_id TEXT NOT NULL,
        status TEXT NOT NULL,
        expires_at TEXT NOT NULL
      )
    `)
    await client.execute(`
      CREATE TABLE communities (
        community_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        provisioning_state TEXT NOT NULL
      )
    `)
    await client.execute(`
      CREATE TABLE community_database_routing (
        community_id TEXT PRIMARY KEY,
        provisioning_state TEXT NOT NULL,
        decommissioned_at TEXT
      )
    `)
    // Distinct stale expiry per community fixes the stalest-first scan order.
    for (const [index, communityId] of communityIds.entries()) {
      await client.execute({
        sql: "INSERT INTO communities (community_id, status, provisioning_state) VALUES (?1, 'active', 'active')",
        args: [communityId],
      })
      await client.execute({
        sql: "INSERT INTO community_database_routing (community_id, provisioning_state, decommissioned_at) VALUES (?1, 'ready', NULL)",
        args: [communityId],
      })
      await client.execute({
        sql: "INSERT INTO song_artifact_upload_sessions (community_id, status, expires_at) VALUES (?1, 'created', ?2)",
        args: [communityId, `2020-01-0${index + 1}T00:00:00.000Z`],
      })
    }
  } finally {
    client.close()
  }
  return { CONTROL_PLANE_DATABASE_URL: `file:${path}` } as unknown as Env
}

describe("reconcileStaleSongArtifactUploadSessionJobs prelude deadline", () => {
  it("checks every community when no deadline is configured", async () => {
    const env = await createControlPlane(["cmt_1", "cmt_2", "cmt_3"])
    const summary = await reconcileStaleSongArtifactUploadSessionJobs({
      env,
      communityRepository: repository,
      deadlineAtMs: null,
    })

    expect(summary.checked_communities).toBe(3)
    expect(summary.deferred_communities).toBe(0)
  })

  it("starts no community when the deadline is already spent", async () => {
    const env = await createControlPlane(["cmt_1", "cmt_2", "cmt_3"])
    let observations = 0
    const summary = await reconcileStaleSongArtifactUploadSessionJobs({
      env,
      communityRepository: repository,
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
    const env = await createControlPlane(["cmt_1", "cmt_2", "cmt_3", "cmt_4", "cmt_5"])
    let clock = 0
    const summary = await reconcileStaleSongArtifactUploadSessionJobs({
      env,
      communityRepository: repository,
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
    const runTick = async (minuteMs: number) => {
      const env = await createControlPlane(["cmt_1", "cmt_2", "cmt_3"])
      let clock = minuteMs
      return reconcileStaleSongArtifactUploadSessionJobs({
        env,
        communityRepository: repository,
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
