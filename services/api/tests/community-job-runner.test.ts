import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import { enqueueCommunityJob } from "../src/lib/communities/jobs/store"
import type { CommunityRepository } from "../src/lib/communities/db-community-repository"
import { processAvailableCommunityJobs, processNextCommunityJob, runCommunityJobWorkerLoop } from "../src/lib/communities/jobs/runner"
import type { CommunityRow } from "../src/lib/auth/auth-db-rows"
import { createComment } from "../src/lib/comments/comment-service"
import { getCommentById } from "../src/lib/comments/community-comment-store"
import { getPostById, insertPost } from "../src/lib/posts/community-post-store"
import { setSwarmPublisherForTests } from "../src/lib/swarm/swarm-publisher"
import type { Env } from "../src/types"
import {
  buildCommunityRepository,
  buildUserRepository,
  buildVerifiedUser,
  cleanupCommunityJobRunnerArtifacts,
  createCommunityJobRunnerRoot,
  fetchCommunityJobs,
  fetchThreadSnapshots,
  seedCommunityState,
  type TestCommunityRepository,
} from "./community-job-runner-test-helpers"
const originalFetch = globalThis.fetch

afterEach(async () => {
  setSwarmPublisherForTests(null)
  globalThis.fetch = originalFetch
  await cleanupCommunityJobRunnerArtifacts()
})

describe("community-job-runner", () => {
  test("configures local community sqlite connections for concurrent worker access", async () => {
    const rootDir = await createCommunityJobRunnerRoot("pirate-community-job-sqlite-config-")
    const communityId = "cmt_job_sqlite_config"
    const env: Env = {
      LOCAL_COMMUNITY_DB_ROOT: rootDir,
    }
    const repo = buildCommunityRepository(join(rootDir, "sqlite-config.db"), communityId)

    await seedCommunityState({
      env,
      repo,
      communityId,
      memberUserIds: ["usr_owner"],
    })

    const db = await openCommunityDb(env, repo, communityId)
    try {
      const journalMode = await db.client.execute("PRAGMA journal_mode")
      expect(String(journalMode.rows[0]?.journal_mode ?? "")).toBe("wal")

      const busyTimeout = await db.client.execute("PRAGMA busy_timeout")
      expect(Number(busyTimeout.rows[0]?.timeout ?? 0)).toBe(5000)
    } finally {
      db.close()
    }
  })

  test("processes projection retry jobs and repopulates comment projections", async () => {
    const rootDir = await createCommunityJobRunnerRoot("pirate-community-job-runner-")

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
    const rootDir = await createCommunityJobRunnerRoot("pirate-community-job-loop-")

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
    const rootDir = await createCommunityJobRunnerRoot("pirate-community-job-backoff-")

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
    const rootDir = await createCommunityJobRunnerRoot("pirate-community-job-snapshot-")

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

  test("hydrates generic link preview metadata into link posts", async () => {
    const rootDir = await createCommunityJobRunnerRoot("pirate-community-link-preview-")
    const communityId = "cmt_job_link_preview"
    const env: Env = {
      LOCAL_COMMUNITY_DB_ROOT: rootDir,
    }
    const repo = buildCommunityRepository(join(rootDir, "link-preview.db"), communityId)

    await seedCommunityState({
      env,
      repo,
      communityId,
      memberUserIds: ["usr_owner"],
    })

    let linkPostId = ""
    const db = await openCommunityDb(env, repo, communityId)
    try {
      const now = new Date().toISOString()
      const linkPost = await insertPost({
        client: db.client,
        communityId,
        authorUserId: "usr_owner",
        body: {
          post_type: "link",
          link_url: "https://example.com/posts/story",
          idempotency_key: "link-preview-post",
        },
        createdAt: now,
      })
      linkPostId = linkPost.post_id

      await enqueueCommunityJob({
        client: db.client,
        communityId,
        jobType: "embed_hydrate",
        subjectType: "post_embed",
        subjectId: linkPost.post_id,
        payloadJson: JSON.stringify({
          post_id: linkPost.post_id,
          link_url: linkPost.link_url,
        }),
        createdAt: now,
      })
    } finally {
      db.close()
    }

    globalThis.fetch = (async (input) => {
      expect(input instanceof Request ? input.url : String(input)).toBe("https://example.com/posts/story")
      return new Response(`
        <html>
          <head>
            <meta property="og:title" content="Example story title">
            <meta property="og:image" content="/assets/story-card.jpg">
          </head>
        </html>
      `, {
        headers: {
          "content-type": "text/html",
        },
      })
    }) as typeof fetch

    const processed = await processNextCommunityJob({
      env,
      communityId,
      communityRepository: repo,
    })

    expect(processed?.job_type).toBe("embed_hydrate")
    expect(processed?.error_code).toBeNull()
    expect(processed?.status).toBe("succeeded")
    expect(processed?.result_ref).toBe("https://example.com/assets/story-card.jpg")

    const verifyDb = await openCommunityDb(env, repo, communityId)
    try {
      const post = await getPostById(verifyDb.client, linkPostId)
      expect(post?.title).toBeNull()
      expect(post?.link_og_title).toBe("Example story title")
      expect(post?.link_og_image_url).toBe("https://example.com/assets/story-card.jpg")
      expect(post?.embeds).toBe(undefined)
    } finally {
      verifyDb.close()
    }
  })

  test("hydrates X embeds idempotently into link posts", async () => {
    const rootDir = await createCommunityJobRunnerRoot("pirate-community-x-embed-")
    const communityId = "cmt_job_x_embed"
    const env: Env = {
      LOCAL_COMMUNITY_DB_ROOT: rootDir,
    }
    const repo = buildCommunityRepository(join(rootDir, "x-embed.db"), communityId)

    await seedCommunityState({
      env,
      repo,
      communityId,
      memberUserIds: ["usr_owner"],
    })

    let linkPostId = ""
    const db = await openCommunityDb(env, repo, communityId)
    try {
      const now = new Date().toISOString()
      const linkPost = await insertPost({
        client: db.client,
        communityId,
        authorUserId: "usr_owner",
        body: {
          post_type: "link",
          link_url: "https://x.com/pirate/status/1234567890123456789?s=20",
          idempotency_key: "x-embed-post",
        },
        createdAt: now,
      })
      linkPostId = linkPost.post_id

      await enqueueCommunityJob({
        client: db.client,
        communityId,
        jobType: "embed_hydrate",
        subjectType: "post_embed",
        subjectId: linkPost.post_id,
        payloadJson: JSON.stringify({
          post_id: linkPost.post_id,
          link_url: linkPost.link_url,
        }),
        createdAt: now,
      })
    } finally {
      db.close()
    }

    globalThis.fetch = (async (input) => {
      const requestUrl = input instanceof Request ? input.url : String(input)
      const parsed = new URL(requestUrl)
      if (parsed.origin + parsed.pathname === "https://publish.x.com/oembed") {
        expect(parsed.searchParams.get("url")).toBe("https://x.com/pirate/status/1234567890123456789")
        expect(parsed.searchParams.get("omit_script")).toBe("1")
        expect(parsed.searchParams.get("dnt")).toBe("true")
        return Response.json({
          author_name: "Pirate",
          author_url: "https://x.com/pirate",
          cache_age: "3153600000",
          html: `<blockquote class="twitter-tweet"><p lang="en" dir="ltr">X embed text</p>&mdash; Pirate <a href="https://x.com/pirate/status/1234567890123456789">April 23, 2026</a></blockquote><script async src="https://platform.x.com/widgets.js"></script>`,
        })
      }
      expect(requestUrl).toBe("https://x.com/pirate/status/1234567890123456789")
      return new Response(`
        <html>
          <head>
            <meta property="og:image" content="https://pbs.twimg.com/media/example.jpg">
          </head>
        </html>
      `, {
        headers: {
          "content-type": "text/html",
        },
      })
    }) as typeof fetch

    const processed = await processNextCommunityJob({
      env,
      communityId,
      communityRepository: repo,
    })

    expect(processed?.job_type).toBe("embed_hydrate")
    expect(processed?.error_code).toBeNull()
    expect(processed?.status).toBe("succeeded")
    expect(processed?.result_ref).toBe("https://x.com/pirate/status/1234567890123456789")

    const rerunDb = await openCommunityDb(env, repo, communityId)
    try {
      const job = await enqueueCommunityJob({
        client: rerunDb.client,
        communityId,
        jobType: "embed_hydrate",
        subjectType: "post_embed",
        subjectId: `${linkPostId}:rerun`,
        payloadJson: JSON.stringify({
          post_id: linkPostId,
          link_url: "https://twitter.com/pirate/status/1234567890123456789",
        }),
        createdAt: new Date().toISOString(),
      })
      await processNextCommunityJob({
        env,
        communityId,
        communityRepository: repo,
      })
      expect(job.job_type).toBe("embed_hydrate")
    } finally {
      rerunDb.close()
    }

    const verifyDb = await openCommunityDb(env, repo, communityId)
    try {
      const post = await getPostById(verifyDb.client, linkPostId)
      expect(post?.link_og_title).toBe("X embed text")
      expect(post?.link_og_image_url).toBe("https://pbs.twimg.com/media/example.jpg")
      expect(post?.embeds?.length).toBe(1)
      expect(post?.embeds?.[0]?.provider).toBe("x")
      expect(post?.embeds?.[0]?.provider_ref).toBe("1234567890123456789")
      expect(post?.embeds?.[0]?.canonical_url).toBe("https://x.com/pirate/status/1234567890123456789")
      expect(post?.embeds?.[0]?.state).toBe("embed")
      const embed = post?.embeds?.[0]
      if (embed?.provider !== "x") throw new Error("expected X embed")
      expect(embed.preview?.media_url).toBe("https://pbs.twimg.com/media/example.jpg")
      expect(post?.embeds?.[0]?.oembed_html).toContain("twitter-tweet")
      expect(post?.embeds?.[0]?.oembed_html).not.toContain("<script")
      const rows = await verifyDb.client.execute({
        sql: "SELECT COUNT(*) AS count FROM post_embeds WHERE embed_key = ?1",
        args: ["x:1234567890123456789"],
      })
      expect(Number(rows.rows[0]?.count ?? 0)).toBe(1)
    } finally {
      verifyDb.close()
    }
  })

  test("hydrates YouTube embeds into link posts", async () => {
    const rootDir = await createCommunityJobRunnerRoot("pirate-community-youtube-embed-")
    const communityId = "cmt_job_youtube_embed"
    const env: Env = {
      LOCAL_COMMUNITY_DB_ROOT: rootDir,
    }
    const repo = buildCommunityRepository(join(rootDir, "youtube-embed.db"), communityId)

    await seedCommunityState({
      env,
      repo,
      communityId,
      memberUserIds: ["usr_owner"],
    })

    let linkPostId = ""
    const db = await openCommunityDb(env, repo, communityId)
    try {
      const now = new Date().toISOString()
      const linkPost = await insertPost({
        client: db.client,
        communityId,
        authorUserId: "usr_owner",
        body: {
          post_type: "link",
          link_url: "https://youtu.be/dQw4w9WgXcQ?si=test",
          idempotency_key: "youtube-embed-post",
        },
        createdAt: now,
      })
      linkPostId = linkPost.post_id

      await enqueueCommunityJob({
        client: db.client,
        communityId,
        jobType: "embed_hydrate",
        subjectType: "post_embed",
        subjectId: linkPost.post_id,
        payloadJson: JSON.stringify({
          post_id: linkPost.post_id,
          link_url: linkPost.link_url,
        }),
        createdAt: now,
      })
    } finally {
      db.close()
    }

    globalThis.fetch = (async (input) => {
      const requestUrl = input instanceof Request ? input.url : String(input)
      const parsed = new URL(requestUrl)
      expect(parsed.origin + parsed.pathname).toBe("https://www.youtube.com/oembed")
      expect(parsed.searchParams.get("url")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
      expect(parsed.searchParams.get("format")).toBe("json")
      return Response.json({
        author_name: "Rick Astley",
        author_url: "https://www.youtube.com/@RickAstley",
        html: `<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe><script>alert(1)</script>`,
        thumbnail_height: 360,
        thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
        thumbnail_width: 480,
        title: "Never Gonna Give You Up",
      }, {
        headers: {
          "cache-control": "public, max-age=86400",
        },
      })
    }) as typeof fetch

    const processed = await processNextCommunityJob({
      env,
      communityId,
      communityRepository: repo,
    })

    expect(processed?.job_type).toBe("embed_hydrate")
    expect(processed?.error_code).toBeNull()
    expect(processed?.status).toBe("succeeded")
    expect(processed?.result_ref).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ")

    const verifyDb = await openCommunityDb(env, repo, communityId)
    try {
      const post = await getPostById(verifyDb.client, linkPostId)
      expect(post?.link_og_title).toBe("Never Gonna Give You Up")
      expect(post?.link_og_image_url).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg")
      expect(post?.embeds?.length).toBe(1)
      const embed = post?.embeds?.[0]
      if (embed?.provider !== "youtube") throw new Error("expected YouTube embed")
      expect(embed.provider_ref).toBe("dQw4w9WgXcQ")
      expect(embed.canonical_url).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ")
      expect(embed.state).toBe("embed")
      expect(embed.preview?.title).toBe("Never Gonna Give You Up")
      expect(embed.preview?.author_name).toBe("Rick Astley")
      expect(embed.preview?.thumbnail_url).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg")
      expect(embed.oembed_cache_age).toBe(86400)
      expect(embed.oembed_html).toContain("youtube-nocookie.com/embed/dQw4w9WgXcQ")
      expect(embed.oembed_html).not.toContain("<script")
    } finally {
      verifyDb.close()
    }
  })

})
