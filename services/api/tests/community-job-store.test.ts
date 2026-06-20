import { describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import {
  enqueueCommunityJob,
  getCommunityJobById,
  markCommunityJobRunning,
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
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
    })
    expect(firstClaim?.status).toBe("running")
    expect(firstClaim?.attempt_count).toBe(1)

    const secondClaim = await markCommunityJobRunning({
      client,
      jobId: job.job_id,
      now: "2026-06-05T12:00:02.000Z",
    })
    expect(secondClaim).toBeNull()

    const stored = await getCommunityJobById({ client, jobId: job.job_id })
    expect(stored?.status).toBe("running")
    expect(stored?.attempt_count).toBe(1)
  })
})
