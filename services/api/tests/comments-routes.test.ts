import { afterEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import app from "../src/index"
import { buildLocalCommunityDbUrl } from "../src/lib/communities/community-local-db"
import { getCommentById } from "../src/lib/comments/community-comment-store"
import { computeCommentSourceHash } from "../src/lib/localization/content-source-hash"
import type { Env } from "../src/types"
import { createRouteTestContext, json, mintUpstreamJwt, resetRuntimeCaches } from "./helpers"

let cleanup: (() => Promise<void>) | null = null

function requestJson(url: string, body: unknown, env: Env, token?: string, method = "POST"): Promise<Response> {
  return Promise.resolve(app.request(
    url,
    {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  ))
}

async function exchangeJwt(env: Env, sub: string): Promise<{ accessToken: string; userId: string }> {
  const jwt = await mintUpstreamJwt(env, { sub })
  const response = await requestJson("http://pirate.test/auth/session/exchange", {
    proof: {
      type: "jwt_based_auth",
      jwt,
    },
  }, env)
  const body = await json(response) as { access_token: string; user: { user_id: string } }
  return { accessToken: body.access_token, userId: body.user.user_id }
}

async function completeUniqueHumanVerification(env: Env, accessToken: string): Promise<void> {
  const verificationSession = await requestJson("http://pirate.test/verification-sessions", {
    provider: "self",
  }, env, accessToken)
  const verificationBody = await json(verificationSession) as { verification_session_id: string }
  await requestJson(
    `http://pirate.test/verification-sessions/${verificationBody.verification_session_id}/complete`,
    {},
    env,
    accessToken,
  )
}

async function prepareVerifiedNamespace(env: Env, accessToken: string): Promise<string> {
  await completeUniqueHumanVerification(env, accessToken)

  const namespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
    family: "hns",
    root_label: "CommentRoutesCoverageRoot",
  }, env, accessToken)
  const namespaceBody = await json(namespaceSession) as { namespace_verification_session_id: string }
  const completed = await requestJson(
    `http://pirate.test/namespace-verification-sessions/${namespaceBody.namespace_verification_session_id}/complete`,
    {},
    env,
    accessToken,
  )
  const completedBody = await json(completed) as { namespace_verification_id: string }
  return completedBody.namespace_verification_id
}

async function createCommunity(env: Env, accessToken: string, displayName: string): Promise<{ communityId: string }> {
  const namespaceVerificationId = await prepareVerifiedNamespace(env, accessToken)
  const response = await requestJson("http://pirate.test/communities", {
    display_name: displayName,
    namespace: {
      namespace_verification_id: namespaceVerificationId,
    },
  }, env, accessToken)
  expect(response.status).toBe(202)
  const body = await json(response) as { community: { community_id: string } }
  return { communityId: body.community.community_id }
}

async function addCommunityMember(communityDbRoot: string, communityId: string, userId: string): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(communityDbRoot, communityId),
  })

  try {
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        INSERT INTO community_memberships (
          membership_id, community_id, user_id, status, joined_at, left_at, banned_at, created_at, updated_at
        ) VALUES (
          ?1, ?2, ?3, 'member', ?4, NULL, NULL, ?4, ?4
        )
        ON CONFLICT(membership_id) DO UPDATE SET
          status = excluded.status,
          joined_at = excluded.joined_at,
          left_at = excluded.left_at,
          banned_at = excluded.banned_at,
          updated_at = excluded.updated_at
      `,
      args: [`mbr_${communityId}_${userId}`, communityId, userId, now],
    })
  } finally {
    client.close()
  }
}

async function insertThreadSnapshot(input: {
  communityDbRoot: string
  communityId: string
  postId: string
  commentCount: number
  swarmManifestRef: string
  swarmFeedRef?: string | null
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })

  try {
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        INSERT INTO thread_snapshots (
          thread_snapshot_id, community_id, thread_root_post_id, snapshot_seq,
          published_through_comment_created_at, comment_count, swarm_manifest_ref,
          swarm_feed_ref, created_at
        ) VALUES (
          ?1, ?2, ?3, 1,
          ?4, ?5, ?6,
          ?7, ?4
        )
      `,
      args: [
        `tsn_${input.postId}`,
        input.communityId,
        input.postId,
        now,
        input.commentCount,
        input.swarmManifestRef,
        input.swarmFeedRef ?? null,
      ],
    })
  } finally {
    client.close()
  }
}

async function insertCommentTranslation(input: {
  communityDbRoot: string
  communityId: string
  commentId: string
  locale: string
  translatedBody: string
}): Promise<void> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })

  try {
    const comment = await getCommentById(client, input.commentId)
    expect(comment).not.toBeNull()
    const sourceHash = await computeCommentSourceHash(comment!)
    const now = new Date().toISOString()
    await client.execute({
      sql: `
        INSERT INTO content_translations (
          content_translation_id, content_type, content_id, locale, source_hash,
          source_language, outcome, translated_body, translated_caption, provider,
          provider_model, provider_result_json, created_at, updated_at
        ) VALUES (
          ?1, 'comment', ?2, ?3, ?4,
          ?5, 'translated', ?6, NULL, 'test-provider',
          'test-model', NULL, ?7, ?7
        )
      `,
      args: [
        `ctr_${input.commentId}_${input.locale}`,
        input.commentId,
        input.locale,
        sourceHash,
        comment?.source_language ?? "en",
        input.translatedBody,
        now,
      ],
    })
  } finally {
    client.close()
  }
}

async function fetchCommunityJobsByType(input: {
  communityDbRoot: string
  communityId: string
  jobType: string
}): Promise<Array<{ subject_id: string; status: string }>> {
  const client = createClient({
    url: buildLocalCommunityDbUrl(input.communityDbRoot, input.communityId),
  })

  try {
    const result = await client.execute({
      sql: `
        SELECT subject_id, status
        FROM community_jobs
        WHERE job_type = ?1
        ORDER BY created_at ASC, job_id ASC
      `,
      args: [input.jobType],
    })
    return result.rows.map((row) => ({
      subject_id: String(row.subject_id ?? ""),
      status: String(row.status ?? ""),
    }))
  } finally {
    client.close()
  }
}

afterEach(async () => {
  resetRuntimeCaches()
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe("comments routes", () => {
  test("creates top-level comments, replies, and exposes paginated list/context reads", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "comments-routes-creator")
    const community = await createCommunity(ctx.env, creator.accessToken, "Comment Routes Club")

    const member = await exchangeJwt(ctx.env, "comments-routes-member")
    await completeUniqueHumanVerification(ctx.env, member.accessToken)
    await addCommunityMember(ctx.communityDbRoot, community.communityId, member.userId)

    const createdPost = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts`,
      {
        post_type: "text",
        title: "Comment thread",
        body: "Build the thread",
        idempotency_key: "comments-routes-post-1",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as { post_id: string }

    const topLevelComment = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts/${postBody.post_id}/comments`,
      {
        body: "First top-level comment",
      },
      ctx.env,
      member.accessToken,
    )
    expect(topLevelComment.status).toBe(201)
    const topLevelBody = await json(topLevelComment) as { comment_id: string; depth: number; body: string }
    expect(topLevelBody.depth).toBe(0)
    expect(topLevelBody.body).toBe("First top-level comment")

    const reply = await requestJson(
      `http://pirate.test/comments/${topLevelBody.comment_id}/replies`,
      {
        body: "Reply under the top-level comment",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(reply.status).toBe(201)
    const replyBody = await json(reply) as { comment_id: string; parent_comment_id: string | null; depth: number }
    expect(replyBody.parent_comment_id).toBe(topLevelBody.comment_id)
    expect(replyBody.depth).toBe(1)

    const secondReply = await requestJson(
      `http://pirate.test/comments/${topLevelBody.comment_id}/replies`,
      {
        body: "Second reply under the top-level comment",
      },
      ctx.env,
      member.accessToken,
    )
    expect(secondReply.status).toBe(201)
    const secondReplyBody = await json(secondReply) as { comment_id: string }

    const secondTopLevelComment = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts/${postBody.post_id}/comments`,
      {
        body: "Second top-level comment",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(secondTopLevelComment.status).toBe(201)
    const secondTopLevelBody = await json(secondTopLevelComment) as { comment_id: string }

    const thirdTopLevelComment = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts/${postBody.post_id}/comments`,
      {
        body: "Third top-level comment",
      },
      ctx.env,
      member.accessToken,
    )
    expect(thirdTopLevelComment.status).toBe(201)
    const thirdTopLevelBody = await json(thirdTopLevelComment) as { comment_id: string }

    await insertThreadSnapshot({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
      postId: postBody.post_id,
      commentCount: 5,
      swarmManifestRef: "swarm-manifest:test-thread",
      swarmFeedRef: "swarm-feed:test-thread",
    })

    const listedComments = await app.request(
      `http://pirate.test/communities/${community.communityId}/posts/${postBody.post_id}/comments?sort=new&limit=2`,
      {
        headers: {
          authorization: `Bearer ${member.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(listedComments.status).toBe(200)
    const listedCommentsBody = await json(listedComments) as {
      next_cursor: string | null
      thread_snapshot: {
        thread_root_post_id: string
        swarm_manifest_ref: string
        swarm_feed_ref: string | null
      } | null
      items: Array<{ comment: { comment_id: string; direct_reply_count: number } }>
    }
    expect(listedCommentsBody.items).toHaveLength(2)
    expect(listedCommentsBody.items[0]?.comment.comment_id).toBe(thirdTopLevelBody.comment_id)
    expect(listedCommentsBody.items[1]?.comment.comment_id).toBe(secondTopLevelBody.comment_id)
    expect(typeof listedCommentsBody.next_cursor).toBe("string")
    expect(listedCommentsBody.thread_snapshot?.thread_root_post_id).toBe(postBody.post_id)
    expect(listedCommentsBody.thread_snapshot?.swarm_manifest_ref).toBe("swarm-manifest:test-thread")
    expect(listedCommentsBody.thread_snapshot?.swarm_feed_ref).toBe("swarm-feed:test-thread")

    const listedCommentsPageTwo = await app.request(
      `http://pirate.test/communities/${community.communityId}/posts/${postBody.post_id}/comments?sort=new&limit=2&cursor=${encodeURIComponent(listedCommentsBody.next_cursor ?? "")}`,
      {
        headers: {
          authorization: `Bearer ${member.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(listedCommentsPageTwo.status).toBe(200)
    const listedCommentsPageTwoBody = await json(listedCommentsPageTwo) as {
      next_cursor: string | null
      items: Array<{ comment: { comment_id: string; direct_reply_count: number } }>
    }
    expect(listedCommentsPageTwoBody.items).toHaveLength(1)
    expect(listedCommentsPageTwoBody.items[0]?.comment.comment_id).toBe(topLevelBody.comment_id)
    expect(listedCommentsPageTwoBody.items[0]?.comment.direct_reply_count).toBe(2)
    expect(listedCommentsPageTwoBody.next_cursor).toBeNull()

    const replies = await app.request(
      `http://pirate.test/comments/${topLevelBody.comment_id}/replies?sort=new&limit=1`,
      {
        headers: {
          authorization: `Bearer ${member.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(replies.status).toBe(200)
    const repliesBody = await json(replies) as {
      next_cursor: string | null
      thread_snapshot: {
        thread_root_post_id: string
        swarm_manifest_ref: string
      } | null
      items: Array<{ comment: { comment_id: string; parent_comment_id: string | null } }>
    }
    expect(repliesBody.items).toHaveLength(1)
    expect(repliesBody.items[0]?.comment.comment_id).toBe(secondReplyBody.comment_id)
    expect(repliesBody.items[0]?.comment.parent_comment_id).toBe(topLevelBody.comment_id)
    expect(typeof repliesBody.next_cursor).toBe("string")
    expect(repliesBody.thread_snapshot?.thread_root_post_id).toBe(postBody.post_id)
    expect(repliesBody.thread_snapshot?.swarm_manifest_ref).toBe("swarm-manifest:test-thread")

    const repliesPageTwo = await app.request(
      `http://pirate.test/comments/${topLevelBody.comment_id}/replies?sort=new&limit=1&cursor=${encodeURIComponent(repliesBody.next_cursor ?? "")}`,
      {
        headers: {
          authorization: `Bearer ${member.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(repliesPageTwo.status).toBe(200)
    const repliesPageTwoBody = await json(repliesPageTwo) as {
      next_cursor: string | null
      items: Array<{ comment: { comment_id: string; parent_comment_id: string | null } }>
    }
    expect(repliesPageTwoBody.items).toHaveLength(1)
    expect(repliesPageTwoBody.items[0]?.comment.comment_id).toBe(replyBody.comment_id)
    expect(repliesPageTwoBody.next_cursor).toBeNull()

    const context = await app.request(
      `http://pirate.test/comments/${topLevelBody.comment_id}/context?limit=1`,
      {
        headers: {
          authorization: `Bearer ${creator.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(context.status).toBe(200)
    const contextBody = await json(context) as {
      next_replies_cursor: string | null
      thread_snapshot: {
        thread_root_post_id: string
        swarm_feed_ref: string | null
      } | null
      ancestors: Array<{ comment: { comment_id: string } }>
      comment: { comment: { comment_id: string } }
      replies: Array<{ comment: { comment_id: string } }>
    }
    expect(contextBody.ancestors).toHaveLength(0)
    expect(contextBody.comment.comment.comment_id).toBe(topLevelBody.comment_id)
    expect(contextBody.replies).toHaveLength(1)
    expect(contextBody.replies[0]?.comment.comment_id).toBe(secondReplyBody.comment_id)
    expect(typeof contextBody.next_replies_cursor).toBe("string")
    expect(contextBody.thread_snapshot?.thread_root_post_id).toBe(postBody.post_id)
    expect(contextBody.thread_snapshot?.swarm_feed_ref).toBe("swarm-feed:test-thread")

    const contextPageTwo = await app.request(
      `http://pirate.test/comments/${topLevelBody.comment_id}/context?limit=1&cursor=${encodeURIComponent(contextBody.next_replies_cursor ?? "")}`,
      {
        headers: {
          authorization: `Bearer ${creator.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(contextPageTwo.status).toBe(200)
    const contextPageTwoBody = await json(contextPageTwo) as {
      next_replies_cursor: string | null
      thread_snapshot: {
        swarm_manifest_ref: string
      } | null
      ancestors: Array<{ comment: { comment_id: string } }>
      comment: { comment: { comment_id: string } }
      replies: Array<{ comment: { comment_id: string } }>
    }
    expect(contextPageTwoBody.comment.comment.comment_id).toBe(topLevelBody.comment_id)
    expect(contextPageTwoBody.replies).toHaveLength(1)
    expect(contextPageTwoBody.replies[0]?.comment.comment_id).toBe(replyBody.comment_id)
    expect(contextPageTwoBody.next_replies_cursor).toBeNull()
    expect(contextPageTwoBody.thread_snapshot?.swarm_manifest_ref).toBe("swarm-manifest:test-thread")
  })

  test("POST /comments/:commentId/vote enforces verification and records a verified member vote", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "comments-routes-vote-creator")
    const community = await createCommunity(ctx.env, creator.accessToken, "Comment Vote Club")

    const createdPost = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts`,
      {
        post_type: "text",
        title: "Vote on comment",
        body: "Vote body",
        idempotency_key: "comments-routes-post-vote-1",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as { post_id: string }

    const commentResponse = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts/${postBody.post_id}/comments`,
      {
        body: "Vote on me",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(commentResponse.status).toBe(201)
    const commentBody = await json(commentResponse) as { comment_id: string }

    const unverifiedMember = await exchangeJwt(ctx.env, "comments-routes-vote-unverified")
    await addCommunityMember(ctx.communityDbRoot, community.communityId, unverifiedMember.userId)

    const deniedVote = await requestJson(
      `http://pirate.test/comments/${commentBody.comment_id}/vote`,
      { value: 1 },
      ctx.env,
      unverifiedMember.accessToken,
    )
    expect(deniedVote.status).toBe(403)
    const deniedVoteBody = await json(deniedVote) as { code: string }
    expect(deniedVoteBody.code).toBe("verification_required")

    const verifiedMember = await exchangeJwt(ctx.env, "comments-routes-vote-verified")
    await completeUniqueHumanVerification(ctx.env, verifiedMember.accessToken)
    await addCommunityMember(ctx.communityDbRoot, community.communityId, verifiedMember.userId)

    const acceptedVote = await requestJson(
      `http://pirate.test/comments/${commentBody.comment_id}/vote`,
      { value: 1 },
      ctx.env,
      verifiedMember.accessToken,
    )
    expect(acceptedVote.status).toBe(200)
    const acceptedVoteBody = await json(acceptedVote) as { comment_id: string; value: number }
    expect(acceptedVoteBody.comment_id).toBe(commentBody.comment_id)
    expect(acceptedVoteBody.value).toBe(1)
  })

  test("comment read endpoints return localized projections and lazily enqueue missing translations", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "comments-routes-localization-creator")
    const community = await createCommunity(ctx.env, creator.accessToken, "Comment Localization Club")

    const member = await exchangeJwt(ctx.env, "comments-routes-localization-member")
    await completeUniqueHumanVerification(ctx.env, member.accessToken)
    await addCommunityMember(ctx.communityDbRoot, community.communityId, member.userId)

    const createdPost = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts`,
      {
        post_type: "text",
        title: "Localized thread",
        body: "Thread body",
        idempotency_key: "comments-routes-post-localization-1",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as { post_id: string }

    const topLevelComment = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts/${postBody.post_id}/comments`,
      {
        body: "Hello comment from Pirate",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(topLevelComment.status).toBe(201)
    const topLevelBody = await json(topLevelComment) as { comment_id: string }

    const reply = await requestJson(
      `http://pirate.test/comments/${topLevelBody.comment_id}/replies`,
      {
        body: "Reply from Pirate",
      },
      ctx.env,
      member.accessToken,
    )
    expect(reply.status).toBe(201)
    const replyBody = await json(reply) as { comment_id: string }

    await insertCommentTranslation({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
      commentId: topLevelBody.comment_id,
      locale: "nl",
      translatedBody: "Vertaalde reactie van Pirate",
    })

    const listedComments = await app.request(
      `http://pirate.test/communities/${community.communityId}/posts/${postBody.post_id}/comments?locale=nl&limit=10`,
      {
        headers: {
          authorization: `Bearer ${member.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(listedComments.status).toBe(200)
    const listedCommentsBody = await json(listedComments) as {
      items: Array<{
        comment: { comment_id: string }
        resolved_locale: string
        translation_state: string
        machine_translated: boolean
        translated_body: string | null
        source_hash: string
      }>
    }
    expect(listedCommentsBody.items[0]?.comment.comment_id).toBe(topLevelBody.comment_id)
    expect(listedCommentsBody.items[0]?.resolved_locale).toBe("nl")
    expect(listedCommentsBody.items[0]?.translation_state).toBe("ready")
    expect(listedCommentsBody.items[0]?.machine_translated).toBe(true)
    expect(listedCommentsBody.items[0]?.translated_body).toBe("Vertaalde reactie van Pirate")
    expect(typeof listedCommentsBody.items[0]?.source_hash).toBe("string")

    const replies = await app.request(
      `http://pirate.test/comments/${topLevelBody.comment_id}/replies?locale=nl&limit=10`,
      {
        headers: {
          authorization: `Bearer ${member.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(replies.status).toBe(200)
    const repliesBody = await json(replies) as {
      items: Array<{
        comment: { comment_id: string }
        resolved_locale: string
        translation_state: string
        machine_translated: boolean
        translated_body: string | null
      }>
    }
    expect(repliesBody.items[0]?.comment.comment_id).toBe(replyBody.comment_id)
    expect(repliesBody.items[0]?.resolved_locale).toBe("nl")
    expect(repliesBody.items[0]?.translation_state).toBe("pending")
    expect(repliesBody.items[0]?.machine_translated).toBe(false)
    expect(repliesBody.items[0]?.translated_body).toBeNull()

    const context = await app.request(
      `http://pirate.test/comments/${topLevelBody.comment_id}/context?locale=nl&limit=10`,
      {
        headers: {
          authorization: `Bearer ${member.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(context.status).toBe(200)
    const contextBody = await json(context) as {
      comment: {
        translation_state: string
        translated_body: string | null
      }
      replies: Array<{
        comment: { comment_id: string }
        translation_state: string
      }>
    }
    expect(contextBody.comment.translation_state).toBe("ready")
    expect(contextBody.comment.translated_body).toBe("Vertaalde reactie van Pirate")
    expect(contextBody.replies[0]?.comment.comment_id).toBe(replyBody.comment_id)
    expect(contextBody.replies[0]?.translation_state).toBe("pending")

    const translationJobs = await fetchCommunityJobsByType({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
      jobType: "comment_translation_materialize",
    })
    expect(translationJobs.some((job) => job.subject_id === `${replyBody.comment_id}:nl`)).toBe(true)
  })

  test("DELETE /comments/:commentId tombstones the comment and keeps it in context", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "comments-routes-delete-creator")
    const community = await createCommunity(ctx.env, creator.accessToken, "Comment Delete Club")

    const createdPost = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts`,
      {
        post_type: "text",
        title: "Delete comment",
        body: "Delete body",
        idempotency_key: "comments-routes-post-delete-1",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as { post_id: string }

    const commentResponse = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts/${postBody.post_id}/comments`,
      {
        body: "Delete me",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(commentResponse.status).toBe(201)
    const commentBody = await json(commentResponse) as { comment_id: string }

    const deleted = await Promise.resolve(app.request(
      `http://pirate.test/comments/${commentBody.comment_id}`,
      {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${creator.accessToken}`,
        },
      },
      ctx.env,
    ))
    expect(deleted.status).toBe(200)
    const deletedBody = await json(deleted) as { comment_id: string; status: string; body: string | null }
    expect(deletedBody.comment_id).toBe(commentBody.comment_id)
    expect(deletedBody.status).toBe("deleted")
    expect(deletedBody.body).toBe("[deleted]")

    const context = await app.request(
      `http://pirate.test/comments/${commentBody.comment_id}/context?limit=10`,
      {
        headers: {
          authorization: `Bearer ${creator.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(context.status).toBe(200)
    const contextBody = await json(context) as {
      comment: { comment: { status: string; body: string | null } }
    }
    expect(contextBody.comment.comment.status).toBe("deleted")
    expect(contextBody.comment.comment.body).toBe("[deleted]")
  })
})
