import type { Client } from "@libsql/client"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import { enqueueCommunityJob } from "../src/lib/communities/jobs/store"
import type { CommunityDatabaseBindingRepository } from "../src/lib/communities/db-community-repository"
import { createComment } from "../src/lib/comments/comment-service"
import type { Env } from "../src/types"
import {
  buildTestCommunityRepository,
  buildUserRepository,
  buildVerifiedUser,
  cleanupCommunityTestArtifacts,
  createCommunityTestRoot,
  seedTestCommunityState,
  type TestCommunityRepository,
} from "./community-test-helpers"

export { buildUserRepository, buildVerifiedUser }
export type { TestCommunityRepository }

const cleanupPaths: string[] = []

export async function cleanupCommunityJobRunnerArtifacts(): Promise<void> {
  await cleanupCommunityTestArtifacts(cleanupPaths)
}

export async function createCommunityJobRunnerRoot(prefix: string): Promise<string> {
  return await createCommunityTestRoot(cleanupPaths, prefix)
}

export function buildCommunityRepository(databasePath: string, communityId: string): TestCommunityRepository {
  return buildTestCommunityRepository({
    databasePath,
    communityId,
    displayName: "Community Job Runner Test",
    primaryDatabaseBindingId: "cdb_jobs",
    databaseName: "community-jobs",
  })
}

export async function seedCommunityState(input: {
  env: Env
  repo: CommunityDatabaseBindingRepository
  communityId: string
  memberUserIds: string[]
  membershipMode?: "open" | "request" | "gated"
}): Promise<{ postId: string }> {
  return await seedTestCommunityState({
    ...input,
    membershipMode: input.membershipMode ?? "open",
    displayName: "Community Job Runner Test",
    rootPostTitle: "Runner Root",
  })
}

export async function seedCommunityLabels(input: {
  env: Env
  repo: CommunityDatabaseBindingRepository
  communityId: string
  labelEnabled?: boolean
  requireOnTopLevelPosts?: boolean
  definitions: Array<{
    label_id: string
    label: string
    color_token?: string | null
    status?: "active" | "archived"
  }>
}): Promise<void> {
  const db = await openCommunityDb(input.env, input.repo, input.communityId)
  try {
    const now = new Date().toISOString()
    const settingsResult = await db.client.execute({
      sql: `
        SELECT settings_json
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [input.communityId],
    })
    const rawSettings = settingsResult.rows[0]?.settings_json
    const parsedSettings = typeof rawSettings === "string" && rawSettings.trim()
      ? JSON.parse(rawSettings) as Record<string, unknown>
      : {}

    await db.client.execute({
      sql: `
        UPDATE communities
        SET settings_json = ?2,
            updated_at = ?3
        WHERE community_id = ?1
      `,
      args: [
        input.communityId,
        JSON.stringify({
          ...parsedSettings,
          label_policy: {
            label_enabled: input.labelEnabled ?? true,
            require_label_on_top_level_posts: input.requireOnTopLevelPosts ?? false,
            definitions: input.definitions.map((definition, index) => ({
              label_id: definition.label_id,
              label: definition.label,
              description: null,
              color_token: definition.color_token ?? null,
              status: definition.status ?? "active",
              position: index,
              allowed_post_types: null,
            })),
          },
        }),
        now,
      ],
    })

    for (const definition of input.definitions) {
      await db.client.execute({
        sql: `
          INSERT INTO labels (
            label_id, community_id, label, description, color_token, status, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, NULL, ?4, ?5, ?6, ?6
          )
          ON CONFLICT(label_id) DO UPDATE SET
            label = excluded.label,
            color_token = excluded.color_token,
            status = excluded.status,
            updated_at = excluded.updated_at
        `,
        args: [
          definition.label_id,
          input.communityId,
          definition.label,
          definition.color_token ?? null,
          definition.status ?? "active",
          now,
        ],
      })
    }
  } finally {
    db.close()
  }
}

export async function fetchCommunityJobs(client: Client): Promise<Array<{
  job_id: string
  job_type: string
  subject_id: string
  status: string
  result_ref: string | null
  error_code: string | null
  attempt_count: number
  available_at: string | null
}>> {
  const result = await client.execute(`
    SELECT job_id, job_type, subject_id, status, result_ref, error_code, attempt_count, available_at
    FROM community_jobs
    ORDER BY created_at ASC, job_id ASC
  `)
  return result.rows.map((row) => ({
    job_id: String(row.job_id),
    job_type: String(row.job_type),
    subject_id: String(row.subject_id),
    status: String(row.status),
    result_ref: row.result_ref == null ? null : String(row.result_ref),
    error_code: row.error_code == null ? null : String(row.error_code),
    attempt_count: Number(row.attempt_count),
    available_at: row.available_at == null ? null : String(row.available_at),
  }))
}

export async function fetchThreadSnapshots(client: Client): Promise<Array<{
  thread_root_post_id: string
  snapshot_seq: number
  swarm_manifest_ref: string
  swarm_feed_ref: string | null
  comment_count: number
}>> {
  const result = await client.execute(`
    SELECT thread_root_post_id, snapshot_seq, swarm_manifest_ref, swarm_feed_ref, comment_count
    FROM thread_snapshots
    ORDER BY thread_root_post_id ASC, snapshot_seq ASC
  `)
  return result.rows.map((row) => ({
    thread_root_post_id: String(row.thread_root_post_id),
    snapshot_seq: Number(row.snapshot_seq),
    swarm_manifest_ref: String(row.swarm_manifest_ref),
    swarm_feed_ref: row.swarm_feed_ref == null ? null : String(row.swarm_feed_ref),
    comment_count: Number(row.comment_count),
  }))
}

export async function enqueuePostTranslationJob(input: {
  env: Env
  repo: CommunityDatabaseBindingRepository
  communityId: string
  postId: string
  locale: string
  createdAt?: string
}): Promise<void> {
  const db = await openCommunityDb(input.env, input.repo, input.communityId)
  try {
    await enqueueCommunityJob({
      client: db.client,
      communityId: input.communityId,
      jobType: "post_translation_materialize",
      subjectType: "post_translation",
      subjectId: `${input.postId}:${input.locale}`,
      payloadJson: JSON.stringify({
        post_id: input.postId,
        locale: input.locale,
      }),
      createdAt: input.createdAt ?? new Date().toISOString(),
    })
  } finally {
    db.close()
  }
}

export async function enqueuePostLabelJob(input: {
  env: Env
  repo: CommunityDatabaseBindingRepository
  communityId: string
  postId: string
  reason?: "publish" | "edit"
  createdAt?: string
}): Promise<void> {
  const db = await openCommunityDb(input.env, input.repo, input.communityId)
  try {
    await enqueueCommunityJob({
      client: db.client,
      communityId: input.communityId,
      jobType: "post_label_materialize",
      subjectType: "post_label",
      subjectId: input.postId,
      payloadJson: JSON.stringify({
        post_id: input.postId,
        reason: input.reason ?? "publish",
      }),
      createdAt: input.createdAt ?? new Date().toISOString(),
    })
  } finally {
    db.close()
  }
}

export async function enqueueCommentTranslationJob(input: {
  env: Env
  repo: CommunityDatabaseBindingRepository
  communityId: string
  commentId: string
  locale: string
  createdAt?: string
}): Promise<string> {
  const db = await openCommunityDb(input.env, input.repo, input.communityId)
  try {
    await enqueueCommunityJob({
      client: db.client,
      communityId: input.communityId,
      jobType: "comment_translation_materialize",
      subjectType: "comment_translation",
      subjectId: `${input.commentId}:${input.locale}`,
      payloadJson: JSON.stringify({
        comment_id: input.commentId,
        locale: input.locale,
      }),
      createdAt: input.createdAt ?? new Date().toISOString(),
    })
    const jobs = await fetchCommunityJobs(db.client)
    return jobs.find((job) => job.subject_id === `${input.commentId}:${input.locale}`)?.job_id ?? ""
  } finally {
    db.close()
  }
}

export async function enqueueCommunityTextTranslationJob(input: {
  env: Env
  repo: CommunityDatabaseBindingRepository
  communityId: string
  locale: string
  createdAt?: string
}): Promise<string> {
  const db = await openCommunityDb(input.env, input.repo, input.communityId)
  try {
    await enqueueCommunityJob({
      client: db.client,
      communityId: input.communityId,
      jobType: "community_text_translation_materialize",
      subjectType: "community_text_translation",
      subjectId: `${input.communityId}:${input.locale}`,
      payloadJson: JSON.stringify({
        locale: input.locale,
      }),
      createdAt: input.createdAt ?? new Date().toISOString(),
    })
    const jobs = await fetchCommunityJobs(db.client)
    return jobs.find((job) => job.subject_id === `${input.communityId}:${input.locale}`)?.job_id ?? ""
  } finally {
    db.close()
  }
}

export async function createOwnedComment(input: {
  env: Env
  repo: TestCommunityRepository
  communityId: string
  postId: string
  userId: string
}): Promise<{ comment_id: string }> {
  return await createComment({
    env: input.env,
    userId: input.userId,
    communityId: input.communityId,
    threadRootPostId: input.postId,
    body: { body: "Comment to translate from Pirate" },
    userRepository: buildUserRepository({
      [input.userId]: buildVerifiedUser(input.userId),
    }),
    communityRepository: input.repo,
  })
}

export async function updatePostTranslationPolicy(input: {
  env: Env
  repo: CommunityDatabaseBindingRepository
  communityId: string
  postId: string
}): Promise<void> {
  const db = await openCommunityDb(input.env, input.repo, input.communityId)
  try {
    await db.client.execute({
      sql: `
        UPDATE posts
        SET translation_policy = 'machine_allowed'
        WHERE post_id = ?1
      `,
      args: [input.postId],
    })
  } finally {
    db.close()
  }
}
