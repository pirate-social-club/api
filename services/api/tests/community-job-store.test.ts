import { describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import {
  enqueueCommunityJob,
  getCommunityJobById,
  markCommunityJobRunning,
  recycleCommunityJobForRetry,
} from "../src/lib/communities/jobs/store"

async function createJobStoreClient() {
  const client = createClient({ url: ":memory:" })
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
      attempt_id TEXT,
      lease_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  await client.execute(`
    CREATE TABLE community_job_events (
      event_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      community_id TEXT NOT NULL,
      checkpoint TEXT NOT NULL,
      details_json TEXT,
      created_at TEXT NOT NULL
    )
  `)
  return client
}

describe("community job store", () => {
  test("markCommunityJobRunning only claims queued or failed jobs once", async () => {
    const client = await createJobStoreClient()
    const createdAt = "2026-06-05T12:00:00.000Z"
    const job = await enqueueCommunityJob({
      client,
      communityId: "cmt_test",
      jobType: "locked_asset_delivery_prepare",
      subjectType: "asset",
      subjectId: "ast_test",
      createdAt,
    })

    const firstClaim = await markCommunityJobRunning({
      client,
      jobId: job.job_id,
      now: "2026-06-05T12:00:01.000Z",
      attemptDeadlineAt: "2026-06-05T12:30:01.000Z",
      attemptId: "cja_first",
      leaseExpiresAt: "2026-06-05T12:02:01.000Z",
    })
    expect(firstClaim?.status).toBe("running")
    expect(firstClaim?.attempt_count).toBe(1)
    expect(firstClaim?.last_checkpoint).toBe("attempt_started")
    expect(firstClaim?.attempt_deadline_at).toBe("2026-06-05T12:30:01.000Z")

    const secondClaim = await markCommunityJobRunning({
      client,
      jobId: job.job_id,
      now: "2026-06-05T12:00:02.000Z",
      attemptDeadlineAt: "2026-06-05T12:30:02.000Z",
      attemptId: "cja_second",
      leaseExpiresAt: "2026-06-05T12:02:02.000Z",
    })
    expect(secondClaim).toBeNull()

    const stored = await getCommunityJobById({ client, jobId: job.job_id })
    expect(stored?.status).toBe("running")
    expect(stored?.attempt_count).toBe(1)
  })

  test("recycleCommunityJobForRetry resets a running job without clearing attempt history", async () => {
    const client = await createJobStoreClient()
    const job = await enqueueCommunityJob({
      client,
      communityId: "cmt_test",
      jobType: "locked_asset_delivery_prepare",
      subjectType: "asset",
      subjectId: "ast_test",
      createdAt: "2026-06-05T12:00:00.000Z",
    })
    await markCommunityJobRunning({
      client,
      jobId: job.job_id,
      now: "2026-06-05T12:00:01.000Z",
      attemptDeadlineAt: "2026-06-05T12:30:01.000Z",
      attemptId: "cja_recycle",
      leaseExpiresAt: "2026-06-05T12:02:01.000Z",
    })

    const recycled = await recycleCommunityJobForRetry({
      client,
      communityId: "cmt_test",
      jobId: job.job_id,
      now: "2026-06-05T12:02:00.000Z",
      reason: "smoke retry",
    })

    expect(recycled?.before.status).toBe("running")
    expect(recycled?.after.status).toBe("queued")
    expect(recycled?.after.attempt_count).toBe(0)
    expect(recycled?.after.error_code).toBe("operator_recycled:smoke retry")
    expect(recycled?.after.available_at).toBe("2026-06-05T12:02:00.000Z")
    expect(recycled?.after.last_checkpoint).toBeNull()
    expect(recycled?.after.last_checkpoint_at).toBeNull()
    expect(recycled?.after.attempt_started_at).toBeNull()
    expect(recycled?.after.attempt_deadline_at).toBeNull()
  })

  test("recycleCommunityJobForRetry leaves terminal jobs unchanged", async () => {
    const client = await createJobStoreClient()
    const job = await enqueueCommunityJob({
      client,
      communityId: "cmt_test",
      jobType: "locked_asset_delivery_prepare",
      subjectType: "asset",
      subjectId: "ast_test",
      createdAt: "2026-06-05T12:00:00.000Z",
    })

    const recycled = await recycleCommunityJobForRetry({
      client,
      communityId: "cmt_test",
      jobId: job.job_id,
      now: "2026-06-05T12:02:00.000Z",
    })

    expect(recycled?.before.status).toBe("queued")
    expect(recycled?.after.status).toBe("queued")
    expect(recycled?.after.error_code).toBeNull()
  })

  test("recycleCommunityJobForRetry gives attempt-capped jobs a fresh retry budget", async () => {
    const client = await createJobStoreClient()
    const job = await enqueueCommunityJob({
      client,
      communityId: "cmt_test",
      jobType: "locked_asset_delivery_prepare",
      subjectType: "asset",
      subjectId: "ast_test",
      createdAt: "2026-06-05T12:00:00.000Z",
    })
    await client.execute({
      sql: `
        UPDATE community_jobs
        SET status = 'failed',
            error_code = 'community_job_attempt_timeout:720000',
            attempt_count = 8,
            available_at = NULL
        WHERE job_id = ?1
      `,
      args: [job.job_id],
    })

    const recycled = await recycleCommunityJobForRetry({
      client,
      communityId: "cmt_test",
      jobId: job.job_id,
      now: "2026-06-05T12:02:00.000Z",
      reason: "fresh budget",
    })

    expect(recycled?.before.status).toBe("failed")
    expect(recycled?.before.attempt_count).toBe(8)
    expect(recycled?.after.status).toBe("queued")
    expect(recycled?.after.attempt_count).toBe(0)

    const claim = await markCommunityJobRunning({
      client,
      jobId: job.job_id,
      now: "2026-06-05T12:03:00.000Z",
      attemptDeadlineAt: "2026-06-05T12:33:00.000Z",
      attemptId: "cja_fresh_budget",
      leaseExpiresAt: "2026-06-05T12:05:00.000Z",
    })
    expect(claim?.status).toBe("running")
    expect(claim?.attempt_count).toBe(1)
  })
})
