import { describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import { collectCommunityPublishAlertSignals } from "./signals"

async function createSignalsClient() {
  const client = createClient({ url: ":memory:" })
  await client.execute(`
    CREATE TABLE posts (
      post_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      publish_failed_at TEXT,
      publish_failure_code TEXT
    )
  `)
  await client.execute(`
    CREATE TABLE assets (
      asset_id TEXT PRIMARY KEY,
      royalty_allocation_status TEXT NOT NULL,
      royalty_allocation_projection_synced INTEGER NOT NULL DEFAULT 1,
      locked_delivery_status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  await client.execute(`
    CREATE TABLE community_jobs (
      job_id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      job_type TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT,
      result_ref TEXT,
      error_code TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      available_at TEXT,
      last_checkpoint TEXT,
      last_checkpoint_at TEXT,
      attempt_started_at TEXT,
      attempt_deadline_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  return client
}

describe("collectCommunityPublishAlertSignals", () => {
  test("collects stale locked delivery and royalty projection signals", async () => {
    const client = await createSignalsClient()
    const since = "2026-07-08T12:00:00.000Z"

    await client.batch([
      {
        sql: `
          INSERT INTO posts (post_id, status, publish_failed_at, publish_failure_code)
          VALUES (?1, 'failed', ?2, ?3)
        `,
        args: ["pst_failed", "2026-07-08T12:01:00.000Z", "listing_creation_failed"],
      },
      {
        sql: `
          INSERT INTO posts (post_id, status, publish_failed_at, publish_failure_code)
          VALUES (?1, 'failed', ?2, ?3)
        `,
        args: ["pst_ignored", "2026-07-08T12:01:00.000Z", "text_moderation_blocked"],
      },
      {
        sql: `
          INSERT INTO assets (
            asset_id, royalty_allocation_status, royalty_allocation_projection_synced,
            locked_delivery_status, updated_at
          ) VALUES (?1, 'verified', 0, 'ready', ?2)
        `,
        args: ["ast_projection_stale", "2026-07-08T11:00:00.000Z"],
      },
      {
        sql: `
          INSERT INTO assets (
            asset_id, royalty_allocation_status, royalty_allocation_projection_synced,
            locked_delivery_status, updated_at
          ) VALUES (?1, 'verified', 0, 'ready', ?2)
        `,
        args: ["ast_projection_fresh", "2026-07-08T12:01:00.000Z"],
      },
      {
        sql: `
          INSERT INTO assets (
            asset_id, royalty_allocation_status, royalty_allocation_projection_synced,
            locked_delivery_status, updated_at
          ) VALUES (?1, 'none', 1, 'requested', ?2)
        `,
        args: ["ast_delivery_stale", "2026-07-08T11:05:00.000Z"],
      },
      {
        sql: `
          INSERT INTO assets (
            asset_id, royalty_allocation_status, royalty_allocation_projection_synced,
            locked_delivery_status, updated_at
          ) VALUES (?1, 'none', 1, 'requested', ?2)
        `,
        args: ["ast_delivery_fresh", "2026-07-08T12:02:00.000Z"],
      },
      {
        sql: `
          INSERT INTO community_jobs (
            job_id, community_id, job_type, subject_type, subject_id, status,
            attempt_count, last_checkpoint, created_at, updated_at
          ) VALUES (?1, 'cmt_test', 'locked_asset_delivery_prepare', 'asset', ?2, 'failed',
            2, 'story_publish_submitted', ?3, ?4)
        `,
        args: ["job_retry", "ast_retry", "2026-07-08T11:58:00.000Z", "2026-07-08T12:03:00.000Z"],
      },
      {
        sql: `
          INSERT INTO community_jobs (
            job_id, community_id, job_type, subject_type, subject_id, status,
            attempt_count, last_checkpoint, created_at, updated_at
          ) VALUES (?1, 'cmt_test', 'locked_asset_delivery_prepare', 'asset', ?2, 'failed',
            2, 'story_publish_submitted', ?3, ?4)
        `,
        args: ["job_old_retry", "ast_old_retry", "2026-07-08T10:00:00.000Z", "2026-07-08T10:05:00.000Z"],
      },
    ])

    const signals = await collectCommunityPublishAlertSignals({
      client,
      communityId: "cmt_test",
      since,
    })

    expect(signals.failure_codes).toEqual([{ code: "listing_creation_failed", count: 1 }])
    expect(signals.stuck_royalty_allocation_projections).toBe(1)
    expect(signals.stuck_royalty_allocation_projection_samples[0]?.asset_id).toBe("ast_projection_stale")
    expect(signals.stale_locked_delivery_assets).toBe(1)
    expect(signals.stale_locked_delivery_asset_samples[0]?.asset_id).toBe("ast_delivery_stale")
    expect(signals.retried_locked_delivery_jobs).toBe(1)
    expect(signals.retried_locked_delivery_job_samples[0]).toMatchObject({
      job_id: "job_retry",
      asset_id: "ast_retry",
      attempt_count: 2,
      last_checkpoint: "story_publish_submitted",
    })
  })
})
