import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, unlinkSync } from "node:fs"
import crypto from "node:crypto"
import { createClient, type Client } from "@libsql/client"

import {
  findStuckPostPublishFinalizePostIds,
  POST_PUBLISH_FINALIZE_STUCK_AGE_MS,
} from "./post-publish-finalize-handler"
import { COMMUNITY_JOB_MAX_ATTEMPTS } from "./runner-types"

const clients: Client[] = []
const dbPaths: string[] = []

function createTestClient(label: string): Client {
  const path = `/tmp/post-publish-finalize-reconciler-${label}-${crypto.randomUUID()}.sqlite`
  dbPaths.push(path)
  const client = createClient({ url: `file:${path}` })
  clients.push(client)
  return client
}

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.close()
  }
  for (const path of dbPaths.splice(0)) {
    if (existsSync(path)) {
      unlinkSync(path)
    }
  }
})

async function createTables(client: Client): Promise<void> {
  await client.execute(`
    CREATE TABLE posts (
      post_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  await client.execute(`
    CREATE TABLE community_jobs (
      job_id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0
    )
  `)
}

async function insertPost(client: Client, postId: string, status: string, updatedAt: string): Promise<void> {
  await client.execute({
    sql: "INSERT INTO posts (post_id, status, updated_at) VALUES (?1, ?2, ?3)",
    args: [postId, status, updatedAt],
  })
}

async function insertFinalizeJob(client: Client, postId: string, status: string, attemptCount: number): Promise<void> {
  await client.execute({
    sql: `
      INSERT INTO community_jobs (
        job_id, job_type, subject_type, subject_id, status, attempt_count
      ) VALUES (
        ?1, 'post_publish_finalize', 'post', ?2, ?3, ?4
      )
    `,
    args: [`job_${postId}`, postId, status, attemptCount],
  })
}

describe("findStuckPostPublishFinalizePostIds", () => {
  test("returns only old processing posts without a live finalize job", async () => {
    const client = createTestClient("predicate")
    await createTables(client)

    const now = "2026-07-06T12:00:00.000Z"
    const cutoff = new Date(Date.parse(now) - POST_PUBLISH_FINALIZE_STUCK_AGE_MS).toISOString()
    const old = "2026-07-06T11:00:00.000Z"
    const fresh = "2026-07-06T11:55:00.000Z"

    await insertPost(client, "old_failed_exhausted", "processing", old)
    await insertFinalizeJob(client, "old_failed_exhausted", "failed", COMMUNITY_JOB_MAX_ATTEMPTS)

    await insertPost(client, "old_failed_retryable", "processing", old)
    await insertFinalizeJob(client, "old_failed_retryable", "failed", COMMUNITY_JOB_MAX_ATTEMPTS - 1)

    await insertPost(client, "old_no_job", "processing", old)

    await insertPost(client, "old_queued", "processing", old)
    await insertFinalizeJob(client, "old_queued", "queued", 0)

    await insertPost(client, "old_running", "processing", old)
    await insertFinalizeJob(client, "old_running", "running", 1)

    await insertPost(client, "old_succeeded_job", "processing", old)
    await insertFinalizeJob(client, "old_succeeded_job", "succeeded", COMMUNITY_JOB_MAX_ATTEMPTS)

    await insertPost(client, "fresh_exhausted", "processing", fresh)
    await insertFinalizeJob(client, "fresh_exhausted", "failed", COMMUNITY_JOB_MAX_ATTEMPTS)

    await insertPost(client, "published_no_job", "published", old)

    const result = await findStuckPostPublishFinalizePostIds({
      client,
      cutoffUpdatedAt: cutoff,
      limit: 10,
    })

    expect(result).toEqual({
      postIds: ["old_failed_exhausted", "old_no_job", "old_succeeded_job"],
      hasMore: false,
    })
  })

  test("reports when the bounded scan leaves stuck posts for the next pass", async () => {
    const client = createTestClient("limit")
    await createTables(client)
    const cutoff = "2026-07-06T11:45:00.000Z"

    await insertPost(client, "stuck_a", "processing", "2026-07-06T11:00:00.000Z")
    await insertPost(client, "stuck_b", "processing", "2026-07-06T11:01:00.000Z")

    const result = await findStuckPostPublishFinalizePostIds({
      client,
      cutoffUpdatedAt: cutoff,
      limit: 1,
    })

    expect(result).toEqual({
      postIds: ["stuck_a"],
      hasMore: true,
    })
  })
})
