import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Client } from "@libsql/client"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import { enqueueCommunityJob } from "../src/lib/communities/community-job-store"
import type { CommunityRepository } from "../src/lib/communities/db-community-repository"
import { processAvailableCommunityJobs, processCommunityJobById, processNextCommunityJob, runCommunityJobWorkerLoop } from "../src/lib/communities/community-job-runner"
import type { CommunityCommentProjectionRow, CommunityRow } from "../src/lib/auth/auth-db-rows"
import type { UserRepository } from "../src/lib/auth/repositories"
import { createComment } from "../src/lib/comments/comment-service"
import { getCommentById } from "../src/lib/comments/community-comment-store"
import { setSwarmPublisherForTests } from "../src/lib/swarm/swarm-publisher"
import { buildDefaultVerificationCapabilities } from "../src/lib/verification/verification-capabilities"
import { getPostById, insertPost } from "../src/lib/posts/community-post-store"
import { computeCommentSourceHash, computePostSourceHash } from "../src/lib/localization/content-source-hash"
import { getContentTranslation } from "../src/lib/localization/content-translation-store"
import type { Env, User } from "../src/types"

const cleanupPaths: string[] = []
const originalFetch = globalThis.fetch

afterEach(async () => {
  setSwarmPublisherForTests(null)
  globalThis.fetch = originalFetch
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
    display_name: "Community Job Runner Test",
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
    primary_database_binding_id: "cdb_jobs",
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

async function seedCommunityState(input: {
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

async function fetchCommunityJobs(client: Client): Promise<Array<{
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

async function fetchThreadSnapshots(client: Client): Promise<Array<{
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

describe("community-job-runner", () => {
  test("processes projection retry jobs and repopulates comment projections", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-community-job-runner-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, "community.db")
    const communityId = "cmt_job_runner_projection"
    const env: Env = {
      LOCAL_COMMUNITY_DB_ROOT: rootDir,
      SWARM_FEED_PRIVATE_KEY: "1111111111111111111111111111111111111111111111111111111111111111",
      SWARM_FEED_TOPIC_NAMESPACE: "pirate-tests",
    }
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
        body: "Retry my projection",
      },
      userRepository: users,
      communityRepository: repo,
    })

    expect(repo.projections.has(comment.comment_id)).toBe(false)
    setSwarmPublisherForTests(async (input) => {
      if ("topic" in input && "reference" in input) {
        return {
          reference: input.reference,
          feedReference: `swarm-feed:${input.topic}`,
        }
      }
      if ("files" in input) {
        return { reference: `swarm-manifest:${input.indexDocument ?? "index"}` }
      }
      return { reference: `swarm-ref:${input.path}` }
    })

    repo.failProjectionWrites = false

    const processedJobs = []
    for (let index = 0; index < 32; index += 1) {
      const processed = await processNextCommunityJob({
        env,
        communityId,
        communityRepository: repo,
      })
      if (!processed) {
        break
      }
      processedJobs.push(processed)
      const processedTypes = new Set(processedJobs.map((job) => job.job_type))
      if (
        processedTypes.has("comment_body_mirror")
        && processedTypes.has("thread_snapshot_publish")
        && processedTypes.has("comment_projection_sync")
      ) {
        break
      }
    }

    expect(processedJobs.some((job) => job.job_type === "comment_body_mirror")).toBe(true)
    expect(processedJobs.some((job) => job.job_type === "thread_snapshot_publish")).toBe(true)
    expect(processedJobs.some((job) => job.job_type === "comment_projection_sync")).toBe(true)
    expect(repo.projections.get(comment.comment_id)?.source_comment_id).toBe(comment.comment_id)

    const db = await openCommunityDb(env, repo, communityId)
    try {
      const jobs = await fetchCommunityJobs(db.client)
      const canonicalJobs = jobs.filter((job) => job.job_type !== "comment_translation_materialize")
      expect(canonicalJobs.every((job) => job.status === "succeeded")).toBe(true)
      const projectionJob = jobs.find((job) => job.job_type === "comment_projection_sync")
      expect(projectionJob?.result_ref).toBe(comment.comment_id)
      const swarmJobs = canonicalJobs.filter((job) => job.job_type !== "comment_projection_sync")
      expect(swarmJobs.every((job) => typeof job.result_ref === "string")).toBe(true)
      const mirroredComment = await getCommentById(db.client, comment.comment_id)
      expect(mirroredComment?.swarm_body_ref).toBe(`swarm-ref:comments/${comment.comment_id}.json`)
      const snapshots = await fetchThreadSnapshots(db.client)
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]?.thread_root_post_id).toBe(postId)
      expect(snapshots[0]?.snapshot_seq).toBe(1)
      expect(snapshots[0]?.swarm_manifest_ref).toBe("swarm-manifest:thread.json")
      expect(snapshots[0]?.swarm_feed_ref?.startsWith("swarm-feed:pirate-tests:")).toBe(true)
    } finally {
      db.close()
    }
  })

  test("drains available jobs across active communities and the worker loop stops when idle", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-community-job-loop-"))
    cleanupPaths.push(rootDir)

    const env: Env = {
      LOCAL_COMMUNITY_DB_ROOT: rootDir,
      SWARM_FEED_PRIVATE_KEY: "1111111111111111111111111111111111111111111111111111111111111111",
      SWARM_FEED_TOPIC_NAMESPACE: "pirate-tests",
    }
    const users = buildUserRepository({
      usr_owner: buildVerifiedUser("usr_owner"),
      usr_alice: buildVerifiedUser("usr_alice"),
      usr_bob: buildVerifiedUser("usr_bob"),
    })

    const alphaRepo = buildCommunityRepository(join(rootDir, "alpha.db"), "cmt_job_alpha")
    const betaRepo = buildCommunityRepository(join(rootDir, "beta.db"), "cmt_job_beta")

    const combinedRepo = {
      async getCommunityById(communityId: string) {
        return communityId === "cmt_job_alpha"
          ? alphaRepo.getCommunityById(communityId)
          : betaRepo.getCommunityById(communityId)
      },
      async listActiveCommunities() {
        const communities = [
          await alphaRepo.getCommunityById("cmt_job_alpha"),
          await betaRepo.getCommunityById("cmt_job_beta"),
        ]
        return communities.filter((community): community is CommunityRow => community != null)
      },
      async getPrimaryCommunityDatabaseBinding(communityId: string) {
        return communityId === "cmt_job_alpha"
          ? alphaRepo.getPrimaryCommunityDatabaseBinding(communityId)
          : betaRepo.getPrimaryCommunityDatabaseBinding(communityId)
      },
      async getActiveCommunityDbCredential(bindingId: string) {
        return alphaRepo.getActiveCommunityDbCredential(bindingId) ?? betaRepo.getActiveCommunityDbCredential(bindingId)
      },
      async recordCommunityCommentProjection(input: Parameters<TestCommunityRepository["recordCommunityCommentProjection"]>[0]) {
        return input.communityId === "cmt_job_alpha"
          ? alphaRepo.recordCommunityCommentProjection(input)
          : betaRepo.recordCommunityCommentProjection(input)
      },
      async getCommunityCommentProjectionByCommentId(commentId: string) {
        return alphaRepo.getCommunityCommentProjectionByCommentId(commentId)
          ?? betaRepo.getCommunityCommentProjectionByCommentId(commentId)
      },
    } satisfies Pick<
      CommunityRepository,
      | "getCommunityById"
      | "listActiveCommunities"
      | "getPrimaryCommunityDatabaseBinding"
      | "getActiveCommunityDbCredential"
      | "recordCommunityCommentProjection"
      | "getCommunityCommentProjectionByCommentId"
    >

    alphaRepo.failProjectionWrites = true
    betaRepo.failProjectionWrites = true

    const alphaSeed = await seedCommunityState({
      env,
      repo: alphaRepo,
      communityId: "cmt_job_alpha",
      memberUserIds: ["usr_owner", "usr_alice"],
    })
    const betaSeed = await seedCommunityState({
      env,
      repo: betaRepo,
      communityId: "cmt_job_beta",
      memberUserIds: ["usr_owner", "usr_bob"],
    })

    const alphaComment = await createComment({
      env,
      userId: "usr_alice",
      communityId: "cmt_job_alpha",
      threadRootPostId: alphaSeed.postId,
      body: { body: "Alpha comment" },
      userRepository: users,
      communityRepository: alphaRepo,
    })
    const betaComment = await createComment({
      env,
      userId: "usr_bob",
      communityId: "cmt_job_beta",
      threadRootPostId: betaSeed.postId,
      body: { body: "Beta comment" },
      userRepository: users,
      communityRepository: betaRepo,
    })

    alphaRepo.failProjectionWrites = false
    betaRepo.failProjectionWrites = false
    setSwarmPublisherForTests(async (input) => {
      if ("topic" in input && "reference" in input) {
        return {
          reference: input.reference,
          feedReference: `swarm-feed:${input.topic}`,
        }
      }
      if ("files" in input) {
        return { reference: `swarm-manifest:${input.indexDocument ?? "index"}` }
      }
      return { reference: `swarm-ref:${input.path}` }
    })

    const once = await processAvailableCommunityJobs({
      env,
      communityRepository: combinedRepo,
      maxJobsPerCommunity: 10,
    })
    expect(once.processed_jobs).toBe(20)
    expect(once.communities).toHaveLength(2)

    await runCommunityJobWorkerLoop({
      env,
      communityRepository: combinedRepo,
      stopWhenIdle: true,
      pollIntervalMs: 100,
    })

    expect(alphaRepo.projections.get(alphaComment.comment_id)?.source_comment_id).toBe(alphaComment.comment_id)
    expect(betaRepo.projections.get(betaComment.comment_id)?.source_comment_id).toBe(betaComment.comment_id)

    const alphaDb = await openCommunityDb(env, alphaRepo, "cmt_job_alpha")
    try {
      expect((await getCommentById(alphaDb.client, alphaComment.comment_id))?.swarm_body_ref).toBe(
        `swarm-ref:comments/${alphaComment.comment_id}.json`,
      )
      const snapshots = await fetchThreadSnapshots(alphaDb.client)
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]?.swarm_manifest_ref).toBe("swarm-manifest:thread.json")
      expect(snapshots[0]?.swarm_feed_ref?.startsWith("swarm-feed:pirate-tests:")).toBe(true)
    } finally {
      alphaDb.close()
    }

    const betaDb = await openCommunityDb(env, betaRepo, "cmt_job_beta")
    try {
      expect((await getCommentById(betaDb.client, betaComment.comment_id))?.swarm_body_ref).toBe(
        `swarm-ref:comments/${betaComment.comment_id}.json`,
      )
      const snapshots = await fetchThreadSnapshots(betaDb.client)
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]?.swarm_manifest_ref).toBe("swarm-manifest:thread.json")
      expect(snapshots[0]?.swarm_feed_ref?.startsWith("swarm-feed:pirate-tests:")).toBe(true)
    } finally {
      betaDb.close()
    }
  })

  test("backs off failed jobs, stops retrying after the attempt cap, and preserves anonymous comment privacy in swarm payloads", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-community-job-backoff-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, "community.db")
    const communityId = "cmt_job_backoff"
    const env: Env = {
      LOCAL_COMMUNITY_DB_ROOT: rootDir,
      SWARM_FEED_PRIVATE_KEY: "1111111111111111111111111111111111111111111111111111111111111111",
      SWARM_FEED_TOPIC_NAMESPACE: "pirate-tests",
    }
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

    const mirroredPayloads: Array<{ path?: string; payload?: unknown }> = []
    setSwarmPublisherForTests(async (input) => {
      if ("topic" in input && "reference" in input) {
        return {
          reference: input.reference,
          feedReference: `swarm-feed:${input.topic}`,
        }
      }
      if ("files" in input) {
        return { reference: `swarm-manifest:${input.indexDocument ?? "index"}` }
      }
      mirroredPayloads.push({ path: input.path, payload: input.payload })
      if (input.path?.startsWith("comments/")) {
        throw new Error("bee unavailable")
      }
      return { reference: `swarm-ref:${input.path}` }
    })

    const comment = await createComment({
      env,
      userId: "usr_alice",
      communityId,
      threadRootPostId: postId,
      body: {
        body: "Anonymous mirror me",
        identity_mode: "anonymous",
        anonymous_scope: "thread_stable",
      },
      userRepository: users,
      communityRepository: repo,
    })

    const db = await openCommunityDb(env, repo, communityId)
    try {
      await db.client.execute({
        sql: `
          UPDATE community_jobs
          SET status = CASE WHEN job_type = 'comment_body_mirror' THEN status ELSE 'succeeded' END,
              result_ref = CASE WHEN job_type = 'comment_body_mirror' THEN result_ref ELSE 'skipped:test' END,
              available_at = CASE WHEN job_type = 'comment_body_mirror' THEN available_at ELSE NULL END,
              updated_at = ?1
        `,
        args: [new Date().toISOString()],
      })
    } finally {
      db.close()
    }

    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const processed = await processNextCommunityJob({
        env,
        communityId,
        communityRepository: repo,
      })
      expect(processed?.job_type).toBe("comment_body_mirror")
      expect(processed?.status).toBe("failed")
      expect(processed?.attempt_count).toBe(attempt)

      if (attempt < 8) {
        expect(processed?.available_at).not.toBeNull()
      } else {
        expect(processed?.available_at).toBeNull()
      }

      const immediateRetry = await processNextCommunityJob({
        env,
        communityId,
        communityRepository: repo,
      })
      expect(immediateRetry).toBeNull()

      if (attempt < 8) {
        const jobDb = await openCommunityDb(env, repo, communityId)
        try {
          await jobDb.client.execute({
            sql: `
              UPDATE community_jobs
              SET available_at = ?2
              WHERE subject_id = ?1
                AND job_type = 'comment_body_mirror'
            `,
            args: [comment.comment_id, "1970-01-01T00:00:00.000Z"],
          })
        } finally {
          jobDb.close()
        }
      }
    }

    const finalRetry = await processNextCommunityJob({
      env,
      communityId,
      communityRepository: repo,
    })
    expect(finalRetry).toBeNull()

    const payload = mirroredPayloads.find((entry) => entry.path === `comments/${comment.comment_id}.json`)?.payload as
      | { comment?: { author_user_id?: string | null } }
      | undefined
    expect(payload?.comment?.author_user_id ?? null).toBeNull()

    const verifyDb = await openCommunityDb(env, repo, communityId)
    try {
      const jobs = await fetchCommunityJobs(verifyDb.client)
      const mirrorJob = jobs.find((job) => job.job_type === "comment_body_mirror")
      expect(mirrorJob?.status).toBe("failed")
      expect(mirrorJob?.attempt_count).toBe(8)
      expect(mirrorJob?.available_at).toBeNull()
    } finally {
      verifyDb.close()
    }
  })

  test("skips non-public communities and throttles then deduplicates snapshots", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-community-job-snapshot-"))
    cleanupPaths.push(rootDir)

    const env: Env = {
      LOCAL_COMMUNITY_DB_ROOT: rootDir,
      SWARM_FEED_PRIVATE_KEY: "1111111111111111111111111111111111111111111111111111111111111111",
      SWARM_FEED_TOPIC_NAMESPACE: "pirate-tests",
    }
    const users = buildUserRepository({
      usr_owner: buildVerifiedUser("usr_owner"),
      usr_alice: buildVerifiedUser("usr_alice"),
    })

    const openCommunityId = "cmt_job_snapshot_open"
    const openRepo = buildCommunityRepository(join(rootDir, "open.db"), openCommunityId)
    const openSeed = await seedCommunityState({
      env,
      repo: openRepo,
      communityId: openCommunityId,
      memberUserIds: ["usr_owner", "usr_alice"],
    })

    const gatedCommunityId = "cmt_job_snapshot_gated"
    const gatedRepo = buildCommunityRepository(join(rootDir, "gated.db"), gatedCommunityId)
    const gatedSeed = await seedCommunityState({
      env,
      repo: gatedRepo,
      communityId: gatedCommunityId,
      memberUserIds: ["usr_owner", "usr_alice"],
      membershipMode: "gated",
    })

    setSwarmPublisherForTests(async (input) => {
      if ("topic" in input && "reference" in input) {
        return {
          reference: input.reference,
          feedReference: `swarm-feed:${input.topic}`,
        }
      }
      if ("files" in input) {
        return { reference: `swarm-manifest:${input.indexDocument ?? "index"}` }
      }
      return { reference: `swarm-ref:${input.path}` }
    })

    const openComment = await createComment({
      env,
      userId: "usr_alice",
      communityId: openCommunityId,
      threadRootPostId: openSeed.postId,
      body: { body: "Open community comment" },
      userRepository: users,
      communityRepository: openRepo,
    })
    const gatedComment = await createComment({
      env,
      userId: "usr_alice",
      communityId: gatedCommunityId,
      threadRootPostId: gatedSeed.postId,
      body: { body: "Gated community comment" },
      userRepository: users,
      communityRepository: gatedRepo,
    })

    const drainAll = async (repo: CommunityRepository, communityId: string): Promise<void> => {
      while (true) {
        const processed = await processNextCommunityJob({
          env,
          communityId,
          communityRepository: repo,
        })
        if (!processed) {
          break
        }
      }
    }

    await drainAll(openRepo, openCommunityId)
    await drainAll(gatedRepo, gatedCommunityId)

    const openDb = await openCommunityDb(env, openRepo, openCommunityId)
    try {
      const initialSnapshots = await fetchThreadSnapshots(openDb.client)
      expect(initialSnapshots).toHaveLength(1)

      await openDb.client.execute({
        sql: `
          UPDATE thread_snapshots
          SET created_at = '1970-01-01T00:00:00.000Z'
          WHERE thread_root_post_id = ?1
        `,
        args: [openSeed.postId],
      })

      const duplicateJob = await enqueueCommunityJob({
        client: openDb.client,
        communityId: openCommunityId,
        jobType: "thread_snapshot_publish",
        subjectType: "thread",
        subjectId: openSeed.postId,
        payloadJson: JSON.stringify({
          thread_root_post_id: openSeed.postId,
        }),
        createdAt: new Date().toISOString(),
      })
      expect(duplicateJob.job_type).toBe("thread_snapshot_publish")
    } finally {
      openDb.close()
    }

    const duplicateSnapshot = await processNextCommunityJob({
      env,
      communityId: openCommunityId,
      communityRepository: openRepo,
    })
    expect(duplicateSnapshot?.job_type).toBe("thread_snapshot_publish")
    expect(duplicateSnapshot?.status).toBe("succeeded")
    expect(duplicateSnapshot?.result_ref).toBe("swarm-manifest:thread.json")

    const refreshOpenDb = await openCommunityDb(env, openRepo, openCommunityId)
    try {
      await refreshOpenDb.client.execute({
        sql: `
          UPDATE thread_snapshots
          SET created_at = ?2
          WHERE thread_root_post_id = ?1
        `,
        args: [openSeed.postId, new Date().toISOString()],
      })
    } finally {
      refreshOpenDb.close()
    }

    const secondOpenComment = await createComment({
      env,
      userId: "usr_owner",
      communityId: openCommunityId,
      threadRootPostId: openSeed.postId,
      body: { body: "Open community follow-up" },
      userRepository: users,
      communityRepository: openRepo,
    })
    await drainAll(openRepo, openCommunityId)

    const verifyOpenDb = await openCommunityDb(env, openRepo, openCommunityId)
    try {
      expect((await getCommentById(verifyOpenDb.client, openComment.comment_id))?.swarm_body_ref).toBe(
        `swarm-ref:comments/${openComment.comment_id}.json`,
      )
      expect((await getCommentById(verifyOpenDb.client, secondOpenComment.comment_id))?.swarm_body_ref).toBe(
        `swarm-ref:comments/${secondOpenComment.comment_id}.json`,
      )
      const snapshots = await fetchThreadSnapshots(verifyOpenDb.client)
      expect(snapshots).toHaveLength(1)
      expect(snapshots[0]?.thread_root_post_id).toBe(openSeed.postId)
    } finally {
      verifyOpenDb.close()
    }

    const verifyGatedDb = await openCommunityDb(env, gatedRepo, gatedCommunityId)
    try {
      expect((await getCommentById(verifyGatedDb.client, gatedComment.comment_id))?.swarm_body_ref).toBeNull()
      const snapshots = await fetchThreadSnapshots(verifyGatedDb.client)
      expect(snapshots).toHaveLength(0)
      const jobs = await fetchCommunityJobs(verifyGatedDb.client)
      const mirrorJob = jobs.find((job) => job.job_type === "comment_body_mirror")
      const snapshotJob = jobs.find((job) => job.job_type === "thread_snapshot_publish")
      expect(mirrorJob?.result_ref).toBe("skipped:non_public_community")
      expect(snapshotJob?.result_ref).toBe("skipped:non_public_community")
    } finally {
      verifyGatedDb.close()
    }
  })

  test("materializes cached post translations through the community job worker", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-community-job-translation-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, "community.db")
    const communityId = "cmt_job_translation"
    const env: Env = {
      LOCAL_COMMUNITY_DB_ROOT: rootDir,
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_TRANSLATION_MODEL: "google/gemini-2.5-flash-lite-preview-09-2025",
    }
    const repo = buildCommunityRepository(databasePath, communityId)
    const { postId } = await seedCommunityState({
      env,
      repo,
      communityId,
      memberUserIds: ["usr_owner"],
    })

    const policyDb = await openCommunityDb(env, repo, communityId)
    try {
      await policyDb.client.execute({
        sql: `
          UPDATE posts
          SET translation_policy = 'machine_allowed'
          WHERE post_id = ?1
        `,
        args: [postId],
      })
    } finally {
      policyDb.close()
    }

    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                source_language: "en",
                target_locale: "es",
                outcome: "translated",
                translated_body: "Cuerpo traducido",
                translated_caption: null,
              }),
            },
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch

    const db = await openCommunityDb(env, repo, communityId)
    try {
      await enqueueCommunityJob({
        client: db.client,
        communityId,
        jobType: "post_translation_materialize",
        subjectType: "post_translation",
        subjectId: `${postId}:es`,
        payloadJson: JSON.stringify({
          post_id: postId,
          locale: "es",
        }),
        createdAt: new Date().toISOString(),
      })
    } finally {
      db.close()
    }

    const processed = await processNextCommunityJob({
      env,
      communityId,
      communityRepository: repo,
    })
    expect(processed?.job_type).toBe("post_translation_materialize")
    expect(processed?.status).toBe("succeeded")
    expect(processed?.result_ref).toBe("es:translated")

    const verifyDb = await openCommunityDb(env, repo, communityId)
    try {
      const post = await getPostById(verifyDb.client, postId)
      const sourceHash = await computePostSourceHash(post!)
      const translation = await getContentTranslation({
        executor: verifyDb.client,
        contentType: "post",
        contentId: postId,
        locale: "es",
        sourceHash,
      })
      expect(translation?.outcome).toBe("translated")
      expect(translation?.translated_body).toBe("Cuerpo traducido")
      expect(translation?.provider).toBe("openrouter")
    } finally {
      verifyDb.close()
    }
  })

  test("materializes cached comment translations through the community job worker", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pirate-community-job-comment-translation-"))
    cleanupPaths.push(rootDir)

    const databasePath = join(rootDir, "community.db")
    const communityId = "cmt_job_comment_translation"
    const env: Env = {
      LOCAL_COMMUNITY_DB_ROOT: rootDir,
      OPENROUTER_API_KEY: "test-openrouter-key",
      OPENROUTER_TRANSLATION_MODEL: "google/gemini-2.5-flash-lite-preview-09-2025",
    }
    const repo = buildCommunityRepository(databasePath, communityId)
    const { postId } = await seedCommunityState({
      env,
      repo,
      communityId,
      memberUserIds: ["usr_owner"],
    })

    const comment = await createComment({
      env,
      userId: "usr_owner",
      communityId,
      threadRootPostId: postId,
      body: { body: "Comment to translate from Pirate" },
      userRepository: buildUserRepository({
        usr_owner: buildVerifiedUser("usr_owner"),
      }),
      communityRepository: repo,
    })

    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                source_language: "en",
                target_locale: "es",
                outcome: "translated",
                translated_body: "Comentario traducido",
                translated_caption: null,
              }),
            },
          },
        ],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }) as typeof fetch

    const db = await openCommunityDb(env, repo, communityId)
    let jobId: string | null = null
    try {
      await enqueueCommunityJob({
        client: db.client,
        communityId,
        jobType: "comment_translation_materialize",
        subjectType: "comment_translation",
        subjectId: `${comment.comment_id}:es`,
        payloadJson: JSON.stringify({
          comment_id: comment.comment_id,
          locale: "es",
        }),
        createdAt: new Date().toISOString(),
      })
      const jobs = await fetchCommunityJobs(db.client)
      jobId = jobs.find((job) => job.subject_id === `${comment.comment_id}:es`)?.job_id ?? null
    } finally {
      db.close()
    }
    expect(jobId).not.toBeNull()

    const processed = await processCommunityJobById({
      env,
      communityId,
      jobId: jobId!,
      communityRepository: repo,
    })
    expect(processed?.job_type).toBe("comment_translation_materialize")
    expect(processed?.status).toBe("succeeded")
    expect(processed?.result_ref).toBe("es:translated")

    const verifyDb = await openCommunityDb(env, repo, communityId)
    try {
      const storedComment = await getCommentById(verifyDb.client, comment.comment_id)
      const sourceHash = await computeCommentSourceHash(storedComment!)
      const translation = await getContentTranslation({
        executor: verifyDb.client,
        contentType: "comment",
        contentId: comment.comment_id,
        locale: "es",
        sourceHash,
      })
      expect(translation?.outcome).toBe("translated")
      expect(translation?.translated_body).toBe("Comentario traducido")
      expect(translation?.provider).toBe("openrouter")
    } finally {
      verifyDb.close()
    }
  })
})
