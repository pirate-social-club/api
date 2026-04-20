import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Client } from "@libsql/client"
import { expect } from "bun:test"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import { enqueueCommunityJob } from "../src/lib/communities/community-job-store"
import type { CommunityRepository } from "../src/lib/communities/db-community-repository"
import type { CommunityCommentProjectionRow, CommunityRow } from "../src/lib/auth/auth-db-rows"
import type { UserRepository } from "../src/lib/auth/repositories"
import { createComment } from "../src/lib/comments/comment-service"
import { getCommentById } from "../src/lib/comments/community-comment-store"
import { buildDefaultVerificationCapabilities } from "../src/lib/verification/verification-capabilities"
import { insertPost } from "../src/lib/posts/community-post-store"
import type { Env, User } from "../src/types"

export const cleanupPaths: string[] = []

export async function cleanupCommunityJobRunnerArtifacts(): Promise<void> {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
}

export async function createCommunityJobRunnerRoot(prefix: string): Promise<string> {
  const rootDir = await mkdtemp(join(tmpdir(), prefix))
  cleanupPaths.push(rootDir)
  return rootDir
}

export function buildVerifiedUser(userId: string): User {
  const capabilities = buildDefaultVerificationCapabilities()
  const now = new Date().toISOString()
  capabilities.unique_human = {
    state: "verified",
    provider: "self",
    proof_type: "unique_human",
    mechanism: "mock",
    verified_at: now,
  }

  return {
    user_id: userId,
    verification_state: "verified",
    capability_provider: "self",
    verification_capabilities: capabilities,
    created_at: now,
    updated_at: now,
  }
}

export function buildUserRepository(users: Record<string, User>): UserRepository {
  return {
    async getUserById(userId: string) {
      return users[userId] ?? null
    },
    async getWalletAttachmentsByUserId() {
      return []
    },
  }
}

function buildCommunityRow(communityId: string, now: string): CommunityRow {
  return {
    community_id: communityId,
    creator_user_id: "usr_owner",
    display_name: "Community Job Runner Test",
    status: "active",
    provisioning_state: "active",
    transfer_state: "none",
    route_slug: null,
    namespace_verification_id: null,
    pending_namespace_verification_session_id: null,
    primary_database_binding_id: "cdb_jobs",
    created_at: now,
    updated_at: now,
  }
}

export type TestCommunityRepository = CommunityRepository & {
  projections: Map<string, CommunityCommentProjectionRow>
  failProjectionWrites: boolean
}

export function buildCommunityRepository(databasePath: string, communityId: string): TestCommunityRepository {
  const projections = new Map<string, CommunityCommentProjectionRow>()
  const now = new Date().toISOString()
  const community = buildCommunityRow(communityId, now)

  const repo = {
    projections,
    failProjectionWrites: false,
    async getCommunityById(requestedCommunityId: string) {
      return requestedCommunityId === communityId ? community : null
    },
    async listActiveCommunities() {
      return [community]
    },
    async getPrimaryCommunityDatabaseBinding(requestedCommunityId: string) {
      if (requestedCommunityId !== communityId) {
        return null
      }
      return {
        community_database_binding_id: "cdb_jobs",
        community_id: communityId,
        binding_role: "primary",
        organization_slug: "local",
        group_name: "local",
        group_id: null,
        database_name: "community-jobs",
        database_id: null,
        database_url: `file:${databasePath}`,
        location: null,
        status: "active",
        transferred_at: null,
        created_at: now,
        updated_at: now,
      }
    },
    async getActiveCommunityDbCredential() {
      return null
    },
    async recordCommunityCommentProjection(input: {
      communityId: string
      threadRootPostId: string
      sourceCommentId: string
      parentCommentId: string | null
      depth: number
      status: "published" | "hidden" | "removed" | "deleted"
      sourceCreatedAt: string
      actorUserId: string
      createdAt: string
    }) {
      if (repo.failProjectionWrites) {
        throw new Error("projection unavailable")
      }
      const existing = repo.projections.get(input.sourceCommentId)
      const row: CommunityCommentProjectionRow = {
        projection_id: existing?.projection_id ?? `ccp_${input.sourceCommentId}`,
        community_id: input.communityId,
        thread_root_post_id: input.threadRootPostId,
        source_comment_id: input.sourceCommentId,
        parent_comment_id: input.parentCommentId,
        depth: input.depth,
        status: input.status,
        source_created_at: input.sourceCreatedAt,
        created_at: existing?.created_at ?? input.createdAt,
        updated_at: input.createdAt,
      }
      repo.projections.set(input.sourceCommentId, row)
      return row
    },
    async getCommunityCommentProjectionByCommentId(commentId: string) {
      return repo.projections.get(commentId) ?? null
    },
  }

  return repo as unknown as TestCommunityRepository
}

export async function seedCommunityState(input: {
  env: Env
  repo: CommunityRepository
  communityId: string
  memberUserIds: string[]
  membershipMode?: "open" | "request" | "gated"
}): Promise<{ postId: string }> {
  const db = await openCommunityDb(input.env, input.repo, input.communityId)
  try {
    const now = new Date().toISOString()
    await db.client.execute({
      sql: `
        INSERT INTO communities (
          community_id, display_name, description, status, artist_identity_id, artist_governance_state,
          membership_mode, default_age_gate_policy, allow_anonymous_identity, anonymous_identity_scope,
          donation_partner_id, donation_policy_mode, donation_partner_status, governance_mode,
          settings_json, created_by_user_id, created_at, updated_at
        ) VALUES (
          ?1, ?2, NULL, 'active', NULL, 'fan_run',
          ?3, 'none', 1, 'thread_stable',
          NULL, 'none', 'unconfigured', 'centralized',
          NULL, ?4, ?5, ?5
        )
      `,
      args: [input.communityId, "Community Job Runner Test", input.membershipMode ?? "open", "usr_owner", now],
    })

    for (const userId of input.memberUserIds) {
      await db.client.execute({
        sql: `
          INSERT INTO community_memberships (
            membership_id, community_id, user_id, status, joined_at, left_at, banned_at, created_at, updated_at
          ) VALUES (
            ?1, ?2, ?3, 'member', ?4, NULL, NULL, ?4, ?4
          )
        `,
        args: [`mbr_${userId}`, input.communityId, userId, now],
      })
    }

    const post = await insertPost({
      client: db.client,
      communityId: input.communityId,
      authorUserId: "usr_owner",
      body: {
        post_type: "text",
        title: "Runner Root",
        body: "Top level post body",
        idempotency_key: `seed-post-${input.communityId}`,
      },
      createdAt: now,
    })

    return { postId: post.post_id }
  } finally {
    db.close()
  }
}

export async function seedCommunityLabels(input: {
  env: Env
  repo: CommunityRepository
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
  repo: CommunityRepository
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
  repo: CommunityRepository
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
  repo: CommunityRepository
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
  repo: CommunityRepository
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
  repo: CommunityRepository
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
  repo: CommunityRepository
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

export async function getStoredCommentOrThrow(input: {
  env: Env
  repo: CommunityRepository
  communityId: string
  commentId: string
}) {
  const db = await openCommunityDb(input.env, input.repo, input.communityId)
  try {
    const comment = await getCommentById(db.client, input.commentId)
    expect(comment).not.toBeNull()
    return comment!
  } finally {
    db.close()
  }
}
