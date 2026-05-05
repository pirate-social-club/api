import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import {
  createComment,
  deleteComment,
  removeCommentAsModerator,
  setCommentReplyLock,
} from "../src/lib/comments/comment-service"
import { setPostCommentsLocked } from "../src/lib/posts/community-post-store"
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

      const closureKey = (row: { ancestor_comment_id: string; descendant_comment_id: string; distance: number }) =>
        `${row.ancestor_comment_id}:${row.descendant_comment_id}:${row.distance}`
      const closureRows = await fetchClosureRows(db.client)
      expect(closureRows.map(closureKey).sort()).toEqual([
        `${first.comment_id}:${first.comment_id}:0`,
        `${first.comment_id}:${second.comment_id}:1`,
        `${second.comment_id}:${second.comment_id}:0`,
      ].sort())

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

  test("blocks member comments on locked posts while moderators can bypass", async () => {
    const rootDir = await createCommentServiceRoot("pirate-comment-service-lock-")

    const databasePath = join(rootDir, "community.db")
    const communityId = "cmt_comment_lock"
    const env: Env = { LOCAL_COMMUNITY_DB_ROOT: rootDir }
    const repo = buildCommunityRepository(databasePath, communityId)
    const users = buildUserRepository({
      usr_owner: buildVerifiedUser("usr_owner"),
      usr_mod: buildVerifiedUser("usr_mod"),
      usr_alice: buildVerifiedUser("usr_alice"),
    })
    const { postId } = await seedCommunityState({
      env,
      repo,
      communityId,
      memberUserIds: ["usr_owner", "usr_mod", "usr_alice"],
    })

    const db = await openCommunityDb(env, repo, communityId)
    try {
      const now = new Date().toISOString()
      await db.client.execute({
        sql: `
          INSERT INTO community_roles (
            role_assignment_id, community_id, user_id, role, status, granted_at, created_at, updated_at
          ) VALUES (
            'rol_mod_lock', ?1, 'usr_mod', 'moderator', 'active', ?2, ?2, ?2
          )
        `,
        args: [communityId, now],
      })
      await setPostCommentsLocked({
        executor: db.client,
        postId,
        locked: true,
        actorUserId: "usr_mod",
        reason: "cooldown",
        now,
      })
    } finally {
      db.close()
    }

    await expect(createComment({
      env,
      userId: "usr_alice",
      communityId,
      threadRootPostId: postId,
      body: { body: "blocked" },
      userRepository: users,
      communityRepository: repo,
    })).rejects.toThrow("Comments are locked for this post")

    const modComment = await createComment({
      env,
      userId: "usr_mod",
      communityId,
      threadRootPostId: postId,
      body: { body: "mod bypass" },
      userRepository: users,
      communityRepository: repo,
    })
    expect(modComment.body).toBe("mod bypass")
  })

  test("blocks member replies on locked comments while moderators can bypass", async () => {
    const rootDir = await createCommentServiceRoot("pirate-comment-service-reply-lock-")

    const databasePath = join(rootDir, "community.db")
    const communityId = "cmt_reply_lock"
    const env: Env = { LOCAL_COMMUNITY_DB_ROOT: rootDir }
    const repo = buildCommunityRepository(databasePath, communityId)
    const users = buildUserRepository({
      usr_owner: buildVerifiedUser("usr_owner"),
      usr_mod: buildVerifiedUser("usr_mod"),
      usr_alice: buildVerifiedUser("usr_alice"),
    })
    const { postId } = await seedCommunityState({
      env,
      repo,
      communityId,
      memberUserIds: ["usr_owner", "usr_mod", "usr_alice"],
    })

    const parent = await createComment({
      env,
      userId: "usr_alice",
      communityId,
      threadRootPostId: postId,
      body: { body: "parent" },
      userRepository: users,
      communityRepository: repo,
    })

    const db = await openCommunityDb(env, repo, communityId)
    try {
      const now = new Date().toISOString()
      await db.client.execute({
        sql: `
          INSERT INTO community_roles (
            role_assignment_id, community_id, user_id, role, status, granted_at, created_at, updated_at
          ) VALUES (
            'rol_mod_reply_lock', ?1, 'usr_mod', 'moderator', 'active', ?2, ?2, ?2
          )
        `,
        args: [communityId, now],
      })
    } finally {
      db.close()
    }

    const lockedParent = await setCommentReplyLock({
      env,
      userId: "usr_mod",
      commentId: parent.comment_id,
      locked: true,
      reason: "answered",
      communityRepository: repo,
    })
    expect(lockedParent.replies_locked).toBe(true)

    await expect(createComment({
      env,
      userId: "usr_alice",
      communityId,
      threadRootPostId: postId,
      parentCommentId: parent.comment_id,
      body: { body: "blocked reply" },
      userRepository: users,
      communityRepository: repo,
    })).rejects.toThrow("Replies are locked for this comment")

    const modReply = await createComment({
      env,
      userId: "usr_mod",
      communityId,
      threadRootPostId: postId,
      parentCommentId: parent.comment_id,
      body: { body: "mod reply" },
      userRepository: users,
      communityRepository: repo,
    })
    expect(modReply.body).toBe("mod reply")
  })

  test("separates author delete from moderator remove", async () => {
    const rootDir = await createCommentServiceRoot("pirate-comment-service-remove-")

    const databasePath = join(rootDir, "community.db")
    const communityId = "cmt_comment_remove"
    const env: Env = { LOCAL_COMMUNITY_DB_ROOT: rootDir }
    const repo = buildCommunityRepository(databasePath, communityId)
    const users = buildUserRepository({
      usr_owner: buildVerifiedUser("usr_owner"),
      usr_mod: buildVerifiedUser("usr_mod"),
      usr_alice: buildVerifiedUser("usr_alice"),
      usr_bob: buildVerifiedUser("usr_bob"),
    })
    const { postId } = await seedCommunityState({
      env,
      repo,
      communityId,
      memberUserIds: ["usr_owner", "usr_mod", "usr_alice", "usr_bob"],
    })

    const db = await openCommunityDb(env, repo, communityId)
    try {
      const now = new Date().toISOString()
      await db.client.execute({
        sql: `
          INSERT INTO community_roles (
            role_assignment_id, community_id, user_id, role, status, granted_at, created_at, updated_at
          ) VALUES (
            'rol_mod_remove', ?1, 'usr_mod', 'moderator', 'active', ?2, ?2, ?2
          )
        `,
        args: [communityId, now],
      })
    } finally {
      db.close()
    }

    const authorDeleted = await createComment({
      env,
      userId: "usr_alice",
      communityId,
      threadRootPostId: postId,
      body: { body: "delete me" },
      userRepository: users,
      communityRepository: repo,
    })
    const modRemoved = await createComment({
      env,
      userId: "usr_bob",
      communityId,
      threadRootPostId: postId,
      body: { body: "remove me" },
      userRepository: users,
      communityRepository: repo,
    })

    await expect(deleteComment({
      env,
      userId: "usr_mod",
      commentId: authorDeleted.comment_id,
      userRepository: users,
      communityRepository: repo,
    })).rejects.toThrow("You do not have permission to delete this comment")

    const deleted = await deleteComment({
      env,
      userId: "usr_alice",
      commentId: authorDeleted.comment_id,
      userRepository: users,
      communityRepository: repo,
    })
    expect(deleted.status).toBe("deleted")

    await expect(removeCommentAsModerator({
      env,
      userId: "usr_alice",
      commentId: modRemoved.comment_id,
      communityRepository: repo,
    })).rejects.toThrow("Moderator access is required")

    const removed = await removeCommentAsModerator({
      env,
      userId: "usr_mod",
      commentId: modRemoved.comment_id,
      communityRepository: repo,
    })
    expect(removed.status).toBe("removed")
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
