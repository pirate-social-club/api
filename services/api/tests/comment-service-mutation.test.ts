import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"
import { openCommunityDb } from "../src/lib/communities/community-db-factory"
import { castCommentVote, createComment, deleteComment } from "../src/lib/comments/comment-service"
import { HttpError } from "../src/lib/errors"
import type { Env } from "../src/types"
import {
  buildCommunityRepository,
  buildUserRepository,
  buildVerifiedUser,
  cleanupCommentServiceArtifacts,
  createCommentServiceRoot,
  fetchCommentStatus,
  seedCommunityState,
} from "./comment-service-test-helpers"

afterEach(async () => {
  await cleanupCommentServiceArtifacts()
})

describe("comment-service mutation", () => {
  test("updates cached vote counters and score when comment votes change", async () => {
    const rootDir = await createCommentServiceRoot("pirate-comment-votes-")

    const databasePath = join(rootDir, "community.db")
    const communityId = "cmt_comment_votes"
    const env: Env = { ENVIRONMENT: "test", LOCAL_COMMUNITY_DB_ROOT: rootDir }
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

  test("reports non-member comment votes with the canonical membership_required code", async () => {
    const rootDir = await createCommentServiceRoot("pirate-comment-vote-nonmember-")

    const databasePath = join(rootDir, "community.db")
    const communityId = "cmt_comment_vote_nonmember"
    const env: Env = { ENVIRONMENT: "test", LOCAL_COMMUNITY_DB_ROOT: rootDir }
    const repo = buildCommunityRepository(databasePath, communityId)
    const users = buildUserRepository({
      usr_owner: buildVerifiedUser("usr_owner"),
      usr_alice: buildVerifiedUser("usr_alice"),
      usr_outsider: buildVerifiedUser("usr_outsider"),
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
      body: { body: "Members vote here" },
      userRepository: users,
      communityRepository: repo,
    })

    expect.assertions(5)
    try {
      await castCommentVote({
        env,
        userId: "usr_outsider",
        commentId: comment.comment_id,
        value: 1,
        userRepository: users,
        communityRepository: repo,
      })
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError)
      const httpError = error as HttpError
      expect(httpError.status).toBe(403)
      expect(httpError.code).toBe("membership_required")
      expect(httpError.message).toBe("Join this community to comment")
      expect(httpError.details).toEqual({
        reason: "membership_required",
        community_id: communityId,
      })
    }
  })

  test("soft deletes comments and preserves projection sync state", async () => {
    const rootDir = await createCommentServiceRoot("pirate-comment-delete-")

    const databasePath = join(rootDir, "community.db")
    const communityId = "cmt_comment_delete"
    const env: Env = { ENVIRONMENT: "test", LOCAL_COMMUNITY_DB_ROOT: rootDir }
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

  test("rejects a non-member comment on a members-only thread with membership_required", async () => {
    const rootDir = await createCommentServiceRoot("pirate-comment-nonmember-")

    const databasePath = join(rootDir, "community.db")
    const communityId = "cmt_comment_nonmember"
    const env: Env = { ENVIRONMENT: "test", LOCAL_COMMUNITY_DB_ROOT: rootDir }
    const repo = buildCommunityRepository(databasePath, communityId)
    const users = buildUserRepository({
      usr_owner: buildVerifiedUser("usr_owner"),
      usr_outsider: buildVerifiedUser("usr_outsider"),
    })
    const { postId } = await seedCommunityState({
      env,
      repo,
      communityId,
      memberUserIds: ["usr_owner"],
    })
    const db = await openCommunityDb(env, repo, communityId)
    try {
      await db.client.execute({
        sql: "UPDATE posts SET visibility = 'members_only' WHERE post_id = ?1",
        args: [postId],
      })
    } finally {
      db.close()
    }

    expect.assertions(4)
    try {
      await createComment({
        env,
        userId: "usr_outsider",
        communityId,
        threadRootPostId: postId,
        body: {
          body: "I am not a member",
        },
        userRepository: users,
        communityRepository: repo,
      })
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError)
      const httpError = error as HttpError
      expect(httpError.status).toBe(403)
      expect(httpError.code).toBe("membership_required")
      expect(httpError.message).toBe("Join this community to comment on this members-only thread")
    }
  })
})
