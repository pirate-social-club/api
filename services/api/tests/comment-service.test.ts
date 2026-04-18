import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Client } from "@libsql/client"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import type { CommunityRepository } from "../src/lib/communities/db-community-repository"
import { createComment, castCommentVote, deleteComment } from "../src/lib/comments/comment-service"
import { getCommentById } from "../src/lib/comments/community-comment-store"
import type { CommentStatus } from "../src/lib/comments/comment-types"
import { insertPost } from "../src/lib/posts/community-post-store"
import { buildDefaultVerificationCapabilities } from "../src/lib/verification/verification-capabilities"
import type { CommunityCommentProjectionRow, CommunityRow } from "../src/lib/auth/auth-db-rows"
import type { UserRepository } from "../src/lib/auth/repositories"
import type { Env, User } from "../src/types"

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

function buildVerifiedUser(userId: string): User {
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

function buildUserRepository(users: Record<string, User>): UserRepository {
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
    display_name: "Comments Test Community",
    status: "active",
    provisioning_state: "active",
    registry_publication_state: "not_started",
    registry_attempt_id: null,
    registry_published_at: null,
    registry_publication_job_id: null,
    registry_error_code: null,
    transfer_state: "none",
    route_slug: null,
    namespace_verification_id: null,
    pending_namespace_verification_session_id: null,
    primary_database_binding_id: "cdb_comments",
    created_at: now,
    updated_at: now,
  }
}

type TestCommunityRepository = CommunityRepository & {
  projections: Map<string, CommunityCommentProjectionRow>
  failProjectionWrites: boolean
}

function buildCommunityRepository(databasePath: string, communityId: string): TestCommunityRepository {
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
        community_database_binding_id: "cdb_comments",
        community_id: communityId,
        binding_role: "primary",
        organization_slug: "local",
        group_name: "local",
        group_id: null,
        database_name: "community-comments",
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

async function seedCommunityState(input: {
  env: Env
  repo: CommunityRepository
  communityId: string
  memberUserIds: string[]
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
          'open', 'none', 1, 'thread_stable',
          NULL, 'none', 'unconfigured', 'centralized',
          NULL, ?3, ?4, ?4
        )
      `,
      args: [input.communityId, "Comments Test Community", "usr_owner", now],
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
        title: "Thread Root",
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

async function fetchCommunityJobs(client: Client): Promise<Array<{ job_type: string; subject_id: string; payload_json: string | null }>> {
  const result = await client.execute(`
    SELECT job_type, subject_id, payload_json
    FROM community_jobs
    ORDER BY created_at ASC, job_id ASC
  `)
  return result.rows.map((row) => ({
    job_type: String(row.job_type),
    subject_id: String(row.subject_id),
    payload_json: row.payload_json == null ? null : String(row.payload_json),
  }))
}

async function fetchPostCounters(client: Client, postId: string): Promise<{ comment_count: number; top_level_comment_count: number; last_comment_at: string | null }> {
  const result = await client.execute({
    sql: `
      SELECT comment_count, top_level_comment_count, last_comment_at
      FROM posts
      WHERE post_id = ?1
      LIMIT 1
    `,
    args: [postId],
  })
  const row = result.rows[0] ?? {}
  return {
    comment_count: Number(row.comment_count ?? 0),
    top_level_comment_count: Number(row.top_level_comment_count ?? 0),
    last_comment_at: row.last_comment_at == null ? null : String(row.last_comment_at),
  }
}

async function fetchClosureRows(client: Client): Promise<Array<{ ancestor_comment_id: string; descendant_comment_id: string; distance: number }>> {
  const result = await client.execute(`
    SELECT ancestor_comment_id, descendant_comment_id, distance
    FROM comment_closure
    ORDER BY ancestor_comment_id ASC, descendant_comment_id ASC, distance ASC
  `)
  return result.rows.map((row) => ({
    ancestor_comment_id: String(row.ancestor_comment_id),
    descendant_comment_id: String(row.descendant_comment_id),
    distance: Number(row.distance),
  }))
}

async function fetchCommentStatus(client: Client, commentId: string): Promise<{ status: CommentStatus; body: string | null; upvote_count: number; downvote_count: number; score: number; direct_reply_count: number; descendant_count: number }> {
  const comment = await getCommentById(client, commentId)
  if (!comment) {
    throw new Error("Missing comment")
  }
  return {
    status: comment.status,
    body: comment.body,
    upvote_count: comment.upvote_count,
    downvote_count: comment.downvote_count,
    score: comment.score,
    direct_reply_count: comment.direct_reply_count,
    descendant_count: comment.descendant_count,
  }
}

describe("comment-service", () => {
  test("creates top-level comments and replies atomically with closure rows, counters, and jobs", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-comment-service-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, "community.db")
    const communityId = "cmt_comments"
    const env: Env = { LOCAL_COMMUNITY_DB_ROOT: rootDir }
    const repo = buildCommunityRepository(databasePath, communityId)
    const users = buildUserRepository({
      usr_owner: buildVerifiedUser("usr_owner"),
      usr_alice: buildVerifiedUser("usr_alice"),
      usr_bob: buildVerifiedUser("usr_bob"),
    })
    const { postId } = await seedCommunityState({
      env,
      repo,
      communityId,
      memberUserIds: ["usr_owner", "usr_alice", "usr_bob"],
    })

    const first = await createComment({
      env,
      userId: "usr_alice",
      communityId,
      threadRootPostId: postId,
      body: {
        body: "First comment",
      },
      userRepository: users,
      communityRepository: repo,
    })

    const second = await createComment({
      env,
      userId: "usr_bob",
      communityId,
      threadRootPostId: postId,
      parentCommentId: first.comment_id,
      body: {
        body: "Reply comment",
      },
      userRepository: users,
      communityRepository: repo,
    })

    expect(first.depth).toBe(0)
    expect(second.depth).toBe(1)
    expect(repo.projections.get(first.comment_id)?.status).toBe("published")
    expect(repo.projections.get(second.comment_id)?.parent_comment_id).toBe(first.comment_id)

    const db = await openCommunityDb(env, repo, communityId)
    try {
      const postCounters = await fetchPostCounters(db.client, postId)
      expect(postCounters.comment_count).toBe(2)
      expect(postCounters.top_level_comment_count).toBe(1)
      expect(postCounters.last_comment_at).toBe(second.created_at)

      const parentState = await fetchCommentStatus(db.client, first.comment_id)
      expect(parentState.direct_reply_count).toBe(1)
      expect(parentState.descendant_count).toBe(1)

      const closureRows = (await fetchClosureRows(db.client)).sort((left, right) =>
        `${left.ancestor_comment_id}:${left.descendant_comment_id}:${left.distance}`.localeCompare(
          `${right.ancestor_comment_id}:${right.descendant_comment_id}:${right.distance}`,
        )
      )
      expect(closureRows).toEqual([
        {
          ancestor_comment_id: first.comment_id,
          descendant_comment_id: first.comment_id,
          distance: 0,
        },
        {
          ancestor_comment_id: first.comment_id,
          descendant_comment_id: second.comment_id,
          distance: 1,
        },
        {
          ancestor_comment_id: second.comment_id,
          descendant_comment_id: second.comment_id,
          distance: 0,
        },
      ].sort((left, right) => `${left.ancestor_comment_id}:${left.descendant_comment_id}:${left.distance}`.localeCompare(
        `${right.ancestor_comment_id}:${right.descendant_comment_id}:${right.distance}`,
      )))

      const jobs = await fetchCommunityJobs(db.client)
      expect(jobs.map((job) => `${job.job_type}:${job.subject_id}`).sort()).toEqual([
        `comment_body_mirror:${first.comment_id}`,
        `thread_snapshot_publish:${postId}`,
        `comment_body_mirror:${second.comment_id}`,
      ].sort())
    } finally {
      db.close()
    }
  })

  test("updates descendant counters only once on the direct parent in deep chains", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-comment-service-deep-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, "community.db")
    const communityId = "cmt_comment_chain"
    const env: Env = { LOCAL_COMMUNITY_DB_ROOT: rootDir }
    const repo = buildCommunityRepository(databasePath, communityId)
    const users = buildUserRepository({
      usr_owner: buildVerifiedUser("usr_owner"),
      usr_alice: buildVerifiedUser("usr_alice"),
      usr_bob: buildVerifiedUser("usr_bob"),
      usr_carla: buildVerifiedUser("usr_carla"),
    })
    const { postId } = await seedCommunityState({
      env,
      repo,
      communityId,
      memberUserIds: ["usr_owner", "usr_alice", "usr_bob", "usr_carla"],
    })

    const rootComment = await createComment({
      env,
      userId: "usr_alice",
      communityId,
      threadRootPostId: postId,
      body: {
        body: "Root comment",
      },
      userRepository: users,
      communityRepository: repo,
    })

    const middleComment = await createComment({
      env,
      userId: "usr_bob",
      communityId,
      threadRootPostId: postId,
      parentCommentId: rootComment.comment_id,
      body: {
        body: "Middle comment",
      },
      userRepository: users,
      communityRepository: repo,
    })

    await createComment({
      env,
      userId: "usr_carla",
      communityId,
      threadRootPostId: postId,
      parentCommentId: middleComment.comment_id,
      body: {
        body: "Leaf comment",
      },
      userRepository: users,
      communityRepository: repo,
    })

    const db = await openCommunityDb(env, repo, communityId)
    try {
      const rootState = await fetchCommentStatus(db.client, rootComment.comment_id)
      const middleState = await fetchCommentStatus(db.client, middleComment.comment_id)

      expect(rootState.direct_reply_count).toBe(1)
      expect(rootState.descendant_count).toBe(2)
      expect(middleState.direct_reply_count).toBe(1)
      expect(middleState.descendant_count).toBe(1)
    } finally {
      db.close()
    }
  })

  test("enqueues projection retry jobs when control-plane projection writes fail", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-comment-projection-retry-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, "community.db")
    const communityId = "cmt_projection_retry"
    const env: Env = { LOCAL_COMMUNITY_DB_ROOT: rootDir }
    const repo = buildCommunityRepository(databasePath, communityId)
    repo.failProjectionWrites = true
    const users = buildUserRepository({
      usr_owner: buildVerifiedUser("usr_owner"),
      usr_alice: buildVerifiedUser("usr_alice"),
    })
    const { postId } = await seedCommunityState({
      env,
      repo,
      communityId,
      memberUserIds: ["usr_owner", "usr_alice"],
    })

    const comment = await createComment({
      env,
      userId: "usr_alice",
      communityId,
      threadRootPostId: postId,
      body: {
        body: "Needs projection retry",
      },
      userRepository: users,
      communityRepository: repo,
    })

    const db = await openCommunityDb(env, repo, communityId)
    try {
      const jobs = await fetchCommunityJobs(db.client)
      expect(jobs.map((job) => job.job_type).sort()).toEqual([
        "comment_body_mirror",
        "thread_snapshot_publish",
        "comment_projection_sync",
      ].sort())
      const retryJob = jobs.find((job) => job.job_type === "comment_projection_sync")
      expect(retryJob?.subject_id).toBe(comment.comment_id)
      expect(retryJob?.payload_json).toContain(comment.comment_id)
    } finally {
      db.close()
    }
  })

  test("updates cached vote counters and score when comment votes change", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-comment-votes-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, "community.db")
    const communityId = "cmt_comment_votes"
    const env: Env = { LOCAL_COMMUNITY_DB_ROOT: rootDir }
    const repo = buildCommunityRepository(databasePath, communityId)
    const users = buildUserRepository({
      usr_owner: buildVerifiedUser("usr_owner"),
      usr_alice: buildVerifiedUser("usr_alice"),
      usr_bob: buildVerifiedUser("usr_bob"),
    })
    const { postId } = await seedCommunityState({
      env,
      repo,
      communityId,
      memberUserIds: ["usr_owner", "usr_alice", "usr_bob"],
    })

    const comment = await createComment({
      env,
      userId: "usr_alice",
      communityId,
      threadRootPostId: postId,
      body: {
        body: "Vote on me",
      },
      userRepository: users,
      communityRepository: repo,
    })

    await castCommentVote({
      env,
      userId: "usr_bob",
      commentId: comment.comment_id,
      value: 1,
      userRepository: users,
      communityRepository: repo,
    })

    await castCommentVote({
      env,
      userId: "usr_bob",
      commentId: comment.comment_id,
      value: -1,
      userRepository: users,
      communityRepository: repo,
    })

    const db = await openCommunityDb(env, repo, communityId)
    try {
      const status = await fetchCommentStatus(db.client, comment.comment_id)
      expect(status.upvote_count).toBe(0)
      expect(status.downvote_count).toBe(1)
      expect(status.score).toBe(-1)
    } finally {
      db.close()
    }
  })

  test("soft deletes comments and preserves projection sync state", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-comment-delete-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, "community.db")
    const communityId = "cmt_comment_delete"
    const env: Env = { LOCAL_COMMUNITY_DB_ROOT: rootDir }
    const repo = buildCommunityRepository(databasePath, communityId)
    const users = buildUserRepository({
      usr_owner: buildVerifiedUser("usr_owner"),
      usr_alice: buildVerifiedUser("usr_alice"),
    })
    const { postId } = await seedCommunityState({
      env,
      repo,
      communityId,
      memberUserIds: ["usr_owner", "usr_alice"],
    })

    const comment = await createComment({
      env,
      userId: "usr_alice",
      communityId,
      threadRootPostId: postId,
      body: {
        body: "Delete me",
      },
      userRepository: users,
      communityRepository: repo,
    })

    const deleted = await deleteComment({
      env,
      userId: "usr_alice",
      commentId: comment.comment_id,
      userRepository: users,
      communityRepository: repo,
    })

    expect(deleted.status).toBe("deleted")
    expect(repo.projections.get(comment.comment_id)?.status).toBe("deleted")

    const db = await openCommunityDb(env, repo, communityId)
    try {
      const status = await fetchCommentStatus(db.client, comment.comment_id)
      expect(status.status).toBe("deleted")
      expect(status.body).toBe("[deleted]")
    } finally {
      db.close()
    }
  })
})
