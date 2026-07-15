import { describe, expect, test } from "bun:test"
import {
  enqueueCommunityJob,
  markCommunityJobSucceeded,
  recordCommunityJobCheckpoint,
  resetStaleRunningCommunityJobById,
  resetStaleRunningCommunityJobs,
} from "./store"

type Statement = { sql: string; args?: unknown[] }

function makeExecutor(input: { rowsAffected?: number } = {}) {
  const statements: Statement[] = []
  return {
    statements,
    executor: {
      async execute(statement: Statement | string) {
        const normalized = typeof statement === "string" ? { sql: statement, args: [] } : statement
        statements.push(normalized)
        return { rows: [], rowsAffected: input.rowsAffected ?? 1 }
      },
    },
  }
}

describe("enqueueCommunityJob", () => {
  test("dedupe:false performs only an INSERT OR IGNORE write", async () => {
    const { executor, statements } = makeExecutor()

    const job = await enqueueCommunityJob({
      client: executor,
      communityId: "cmt_1",
      jobType: "post_publish_finalize",
      subjectType: "post",
      subjectId: "pst_1",
      payloadJson: "{\"post_id\":\"pst_1\"}",
      createdAt: "2026-07-05T00:00:00.000Z",
      dedupe: false,
    })

    expect(job.subject_id).toBe("pst_1")
    expect(statements).toHaveLength(1)
    expect(statements[0]?.sql).toContain("INSERT OR IGNORE INTO community_jobs")
    expect(statements[0]?.sql.toUpperCase()).not.toContain("SELECT")
  })
})

describe("resetStaleRunningCommunityJobById", () => {
  test("scopes stale recovery to the requested job and community", async () => {
    const { executor, statements } = makeExecutor({ rowsAffected: 1 })

    const reset = await resetStaleRunningCommunityJobById({
      client: executor,
      jobId: "cjb_delivery",
      communityId: "cmt_1",
      now: "2026-07-13T14:10:00.000Z",
      staleCheckpointBefore: "2026-07-13T14:08:00.000Z",
    })

    expect(reset).toBe(true)
    expect(statements).toHaveLength(1)
    expect(statements[0]?.sql).toContain("WHERE job_id = ?1")
    expect(statements[0]?.sql).toContain("AND community_id = ?2")
    expect(statements[0]?.args).toEqual([
      "cjb_delivery",
      "cmt_1",
      "2026-07-13T14:10:00.000Z",
      "2026-07-13T14:08:00.000Z",
    ])
  })

  test("checks the absolute deadline even while the lease is live", async () => {
    const { executor, statements } = makeExecutor({ rowsAffected: 1 })
    await resetStaleRunningCommunityJobById({
      client: executor,
      jobId: "cjb_deadline",
      communityId: "cmt_1",
      now: "2026-07-15T10:31:00.000Z",
      staleCheckpointBefore: "2026-07-15T10:29:00.000Z",
    })

    expect(statements[0]?.sql).toContain("(attempt_deadline_at IS NOT NULL AND attempt_deadline_at <= ?3)")
    expect(statements[0]?.sql).toContain("OR (lease_expires_at IS NOT NULL AND lease_expires_at <= ?3)")
  })
})

describe("resetStaleRunningCommunityJobs", () => {
  test("checks the durable deadline independently of lease presence", async () => {
    const { executor, statements } = makeExecutor({ rowsAffected: 1 })
    await resetStaleRunningCommunityJobs({
      client: executor,
      communityId: "cmt_1",
      now: "2026-07-15T10:31:00.000Z",
      deadlineBefore: "2026-07-15T10:31:00.000Z",
      staleCheckpointBefore: "2026-07-15T10:29:00.000Z",
    })

    expect(statements[0]?.sql).toContain("(attempt_deadline_at IS NOT NULL AND attempt_deadline_at <= ?2)")
    expect(statements[0]?.sql).toContain("OR (lease_expires_at IS NOT NULL AND lease_expires_at <= ?3)")
  })
})

describe("community job attempt fencing", () => {
  test("checkpoints require the active attempt id", async () => {
    const { executor, statements } = makeExecutor({ rowsAffected: 0 })
    const recorded = await recordCommunityJobCheckpoint({
      client: executor,
      jobId: "cjb_1",
      communityId: "cmt_1",
      attemptId: "cja_old",
      checkpoint: "story_publish_waiting",
      now: "2026-07-15T10:00:00.000Z",
    })

    expect(recorded).toBe(false)
    expect(statements).toHaveLength(1)
    expect(statements[0]?.sql).toContain("AND attempt_id = ?5")
    expect(statements[0]?.args?.[4]).toBe("cja_old")
  })

  test("an obsolete attempt cannot mark a reclaimed job succeeded", async () => {
    const { executor, statements } = makeExecutor({ rowsAffected: 0 })
    const row = await markCommunityJobSucceeded({
      client: executor,
      jobId: "cjb_1",
      attemptId: "cja_old",
      resultRef: "ast_1",
      now: "2026-07-15T10:00:00.000Z",
    })

    expect(row).toBeNull()
    expect(statements).toHaveLength(1)
    expect(statements[0]?.sql).toContain("AND status = 'running'")
    expect(statements[0]?.sql).toContain("AND attempt_id = ?4")
  })
})
