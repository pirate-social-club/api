import { createClient } from "@libsql/client"
import { expect, mock, test } from "bun:test"

const client = createClient({ url: ":memory:" })
let handlerCalls = 0
let releaseFirst: ((value: string) => void) | null = null
let firstAttemptId: string | null = null
let secondAttemptId: string | null = null

mock.module("../community-read-access", () => ({
  openCommunityWriteClient: mock(async () => ({ client, close: () => undefined })),
}))

mock.module("./handlers", () => ({
  runCommunityJob: mock(async (input: { job: { attempt_id: string | null } }) => {
    handlerCalls += 1
    if (handlerCalls === 1) {
      firstAttemptId = input.job.attempt_id
      return await new Promise<string>((resolve) => {
        releaseFirst = resolve
      })
    }
    secondAttemptId = input.job.attempt_id
    return "replacement-result"
  }),
}))

const { processCommunityJobById } = await import("./runner")

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error("condition_not_reached")
}

test("a reclaimed runner attempt fences the obsolete worker's completion", async () => {
  await client.executeMultiple(`
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
    );
    CREATE TABLE community_job_events (
      event_id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      community_id TEXT NOT NULL,
      checkpoint TEXT NOT NULL,
      details_json TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO community_jobs (
      job_id, community_id, job_type, subject_type, subject_id, status, created_at, updated_at
    ) VALUES (
      'cjb_fence', 'cmt_fence', 'comment_projection_sync', 'comment', 'cmt_subject',
      'queued', '2026-07-15T10:00:00.000Z', '2026-07-15T10:00:00.000Z'
    );
  `)

  const repository = {} as never
  const firstRun = processCommunityJobById({
    env: {} as never,
    communityId: "cmt_fence",
    jobId: "cjb_fence",
    communityRepository: repository,
  })
  await waitFor(() => handlerCalls === 1)

  await client.execute(`
    UPDATE community_jobs
    SET status = 'failed', attempt_id = NULL, lease_expires_at = NULL,
        attempt_deadline_at = NULL, available_at = NULL
    WHERE job_id = 'cjb_fence'
  `)

  const replacement = await processCommunityJobById({
    env: {} as never,
    communityId: "cmt_fence",
    jobId: "cjb_fence",
    communityRepository: repository,
  })
  expect(replacement?.status).toBe("succeeded")
  expect(replacement?.result_ref).toBe("replacement-result")
  expect(firstAttemptId).not.toBeNull()
  expect(secondAttemptId).not.toBeNull()
  expect(secondAttemptId).not.toBe(firstAttemptId)

  releaseFirst?.("obsolete-result")
  expect(await firstRun).toBeNull()

  const final = await client.execute("SELECT status, result_ref FROM community_jobs WHERE job_id = 'cjb_fence'")
  expect(final.rows[0]?.status).toBe("succeeded")
  expect(final.rows[0]?.result_ref).toBe("replacement-result")
})
