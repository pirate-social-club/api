import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import { createComment } from "../src/lib/comments/comment-service"
import type { Env } from "../src/types"
import {
  buildCommunityRepository,
  buildUserRepository,
  buildVerifiedUser,
  cleanupCommentServiceArtifacts,
  createCommentServiceRoot,
  fetchClosureRows,
  fetchCommentStatus,
  fetchCommunityJobs,
  fetchPostCounters,
  seedCommunityState,
} from "./comment-service-test-helpers"

afterEach(async () => {
  await cleanupCommentServiceArtifacts()
})

describe("comment-service", () => {
  test("creates top-level comments and replies atomically with closure rows, counters, and jobs", async () => {
    const rootDir = await createCommentServiceRoot("pirate-comment-service-")

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
      const jobRefs = jobs.map((job) => `${job.job_type}:${job.subject_id}`).sort()
      expect(jobRefs.includes(`comment_body_mirror:${first.comment_id}`)).toBe(true)
      expect(jobRefs.includes(`thread_snapshot_publish:${postId}`)).toBe(true)
      expect(jobRefs.includes(`comment_body_mirror:${second.comment_id}`)).toBe(true)
      const translationJobs = jobs.filter((job) => job.job_type === "comment_translation_materialize")
      expect(translationJobs.length).toBeGreaterThan(0)
      expect(translationJobs.every((job) => job.subject_id.startsWith(`${first.comment_id}:`) || job.subject_id.startsWith(`${second.comment_id}:`))).toBe(true)
    } finally {
      db.close()
    }
  })

  test("updates descendant counters only once on the direct parent in deep chains", async () => {
    const rootDir = await createCommentServiceRoot("pirate-comment-service-deep-")

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
    const rootDir = await createCommentServiceRoot("pirate-comment-projection-retry-")

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
      const jobTypes = jobs.map((job) => job.job_type)
      expect(jobTypes.includes("comment_body_mirror")).toBe(true)
      expect(jobTypes.includes("thread_snapshot_publish")).toBe(true)
      expect(jobTypes.includes("comment_projection_sync")).toBe(true)
      const retryJob = jobs.find((job) => job.job_type === "comment_projection_sync")
      expect(retryJob?.subject_id).toBe(comment.comment_id)
      expect(retryJob?.payload_json).toContain(comment.comment_id)
    } finally {
      db.close()
    }
  })

})
