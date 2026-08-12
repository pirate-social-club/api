import { afterEach, describe, expect, test } from "bun:test"
import { app } from "../../../src/index"
import {
  PUBLIC_READ_CACHE_CONTROL,
  PUBLIC_READ_CDN_CACHE_CONTROL,
} from "../../../src/routes/cache-headers"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import {
  addCommunityMember,
  completeUniqueHumanVerification,
  createCommunity,
  exchangeJwt,
  fetchCommunityJobsByType,
  insertCommentTranslation,
  requestJson,
  setCommentMediaRefs,
} from "./comments-routes-test-helpers"

let cleanup: (() => Promise<void>) | null = null

afterEach(async () => {
  resetRuntimeCaches()
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe("comment read routes", () => {
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
    const postBody = await json(createdPost) as { id: string }

    const topLevelComment = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts/${postBody.id}/comments`,
      {
        body: "Hello comment from Pirate",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(topLevelComment.status).toBe(201)
    const topLevelBody = await json(topLevelComment) as { id: string }

    const reply = await requestJson(
      `http://pirate.test/comments/${topLevelBody.id}/replies`,
      {
        body: "Reply from Pirate",
      },
      ctx.env,
      member.accessToken,
    )
    expect(reply.status).toBe(201)
    const replyBody = await json(reply) as { id: string }

    await insertCommentTranslation({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
      commentId: topLevelBody.id,
      locale: "nl",
      translatedBody: "Vertaalde reactie van Pirate",
    })

    const listedComments = await app.request(
      `http://pirate.test/communities/${community.communityId}/posts/${postBody.id}/comments?locale=nl&limit=10`,
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
        comment: { id: string }
        resolved_locale: string
        translation_state: string
        machine_translated: boolean
        translated_body: string | null
        source_hash: string
        viewer_can_delete?: boolean
      }>
    }
    expect(listedCommentsBody.items[0]?.comment.id).toBe(topLevelBody.id)
    expect(listedCommentsBody.items[0]?.viewer_can_delete).toBe(false)
    expect(listedCommentsBody.items[0]?.resolved_locale).toBe("nl")
    expect(listedCommentsBody.items[0]?.translation_state).toBe("ready")
    expect(listedCommentsBody.items[0]?.machine_translated).toBe(true)
    expect(listedCommentsBody.items[0]?.translated_body).toBe("Vertaalde reactie van Pirate")
    expect(typeof listedCommentsBody.items[0]?.source_hash).toBe("string")

    const creatorListedComments = await app.request(
      `http://pirate.test/communities/${community.communityId}/posts/${postBody.id}/comments?locale=nl&limit=10`,
      {
        headers: {
          authorization: `Bearer ${creator.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(creatorListedComments.status).toBe(200)
    const creatorListedCommentsBody = await json(creatorListedComments) as {
      items: Array<{ comment: { id: string }; viewer_can_delete?: boolean }>
    }
    expect(creatorListedCommentsBody.items[0]?.comment.id).toBe(topLevelBody.id)
    expect(creatorListedCommentsBody.items[0]?.viewer_can_delete).toBe(true)

    const replies = await app.request(
      `http://pirate.test/comments/${topLevelBody.id}/replies?locale=nl&limit=10`,
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
        comment: { id: string }
        resolved_locale: string
        translation_state: string
        machine_translated: boolean
        translated_body: string | null
        viewer_can_delete?: boolean
      }>
    }
    expect(repliesBody.items[0]?.comment.id).toBe(replyBody.id)
    expect(repliesBody.items[0]?.viewer_can_delete).toBe(true)
    expect(repliesBody.items[0]?.resolved_locale).toBe("nl")
    expect(repliesBody.items[0]?.translation_state).toBe("pending")
    expect(repliesBody.items[0]?.machine_translated).toBe(false)
    expect(repliesBody.items[0]?.translated_body).toBeNull()

    const context = await app.request(
      `http://pirate.test/comments/${topLevelBody.id}/context?locale=nl&limit=10`,
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
        viewer_can_delete?: boolean
      }
      replies: Array<{
        comment: { id: string }
        translation_state: string
      }>
    }
    expect(contextBody.comment.translation_state).toBe("ready")
    expect(contextBody.comment.viewer_can_delete).toBe(false)
    expect(contextBody.comment.translated_body).toBe("Vertaalde reactie van Pirate")
    expect(contextBody.replies[0]?.comment.id).toBe(replyBody.id)
    expect(contextBody.replies[0]?.translation_state).toBe("pending")

    const translationJobs = await fetchCommunityJobsByType({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
      jobType: "comment_translation_materialize",
    })
    expect(translationJobs.some((job) => job.subject_id.startsWith(`${replyBody.id.replace(/^cmt_/, "")}:nl:0x`))).toBe(true)
  })

  test("public comment read endpoints return localized projections without auth", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "comments-routes-public-reader-creator")
    const community = await createCommunity(ctx.env, creator.accessToken, "Public Comment Reader Club")

    const member = await exchangeJwt(ctx.env, "comments-routes-public-reader-member")
    await completeUniqueHumanVerification(ctx.env, member.accessToken)
    await addCommunityMember(ctx.communityDbRoot, community.communityId, member.userId)

    const createdPost = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts`,
      {
        post_type: "text",
        title: "Public comment thread",
        body: "Body",
        idempotency_key: "comments-routes-public-thread-1",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as { id: string }

    const topLevelComment = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts/${postBody.id}/comments`,
      {
        body: "Hello from public comments",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(topLevelComment.status).toBe(201)
    const topLevelBody = await json(topLevelComment) as { id: string }

    const reply = await requestJson(
      `http://pirate.test/comments/${topLevelBody.id}/replies`,
      {
        body: "Reply from public comments",
      },
      ctx.env,
      member.accessToken,
    )
    expect(reply.status).toBe(201)
    const replyBody = await json(reply) as { id: string }

    await insertCommentTranslation({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
      commentId: topLevelBody.id,
      locale: "zh-Hans",
      translatedBody: "来自 Pirate 的公开评论",
    })

    const publicTopLevel = await app.request(
      `http://pirate.test/public-comments/posts/${postBody.id}/comments?locale=zh-Hans&limit=10`,
      {},
      ctx.env,
    )
    expect(publicTopLevel.status).toBe(200)
    expect(publicTopLevel.headers.get("cdn-cache-control")).toBe(PUBLIC_READ_CDN_CACHE_CONTROL)
    expect(publicTopLevel.headers.get("cache-control")).toBe(PUBLIC_READ_CACHE_CONTROL)
    const publicTopLevelBody = await json(publicTopLevel) as {
      items: Array<{
        comment: { id: string }
        resolved_locale: string
        translation_state: string
        translated_body: string | null
        viewer_can_delete?: boolean
      }>
    }
    expect(publicTopLevelBody.items[0]?.comment.id).toBe(topLevelBody.id)
    expect(publicTopLevelBody.items[0]?.viewer_can_delete).toBe(false)
    expect(publicTopLevelBody.items[0]?.resolved_locale).toBe("zh-Hans")
    expect(publicTopLevelBody.items[0]?.translation_state).toBe("ready")
    expect(publicTopLevelBody.items[0]?.translated_body).toBe("来自 Pirate 的公开评论")

    const publicReplies = await app.request(
      `http://pirate.test/public-comments/${topLevelBody.id}/replies?locale=zh-Hans&limit=10`,
      {},
      ctx.env,
    )
    expect(publicReplies.status).toBe(200)
    expect(publicReplies.headers.get("cdn-cache-control")).toBe(PUBLIC_READ_CDN_CACHE_CONTROL)
    expect(publicReplies.headers.get("cache-control")).toBe(PUBLIC_READ_CACHE_CONTROL)
    const publicRepliesBody = await json(publicReplies) as {
      items: Array<{
        comment: { id: string }
        resolved_locale: string
        translation_state: string
        viewer_can_delete?: boolean
      }>
    }
    expect(publicRepliesBody.items[0]?.comment.id).toBe(replyBody.id)
    expect(publicRepliesBody.items[0]?.viewer_can_delete).toBe(false)
    expect(publicRepliesBody.items[0]?.resolved_locale).toBe("zh-Hans")
    expect(publicRepliesBody.items[0]?.translation_state).toBe("pending")
  })

  test("public comment routes hide comments on private posts", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const creator = await exchangeJwt(ctx.env, "comments-routes-private-reader-creator")
    await completeUniqueHumanVerification(ctx.env, creator.accessToken)
    const community = await createCommunity(ctx.env, creator.accessToken, "Private Comment Reader Club")

    const member = await exchangeJwt(ctx.env, "comments-routes-private-reader-member")
    await completeUniqueHumanVerification(ctx.env, member.accessToken)
    await addCommunityMember(ctx.communityDbRoot, community.communityId, member.userId)

    const createdPost = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts`,
      {
        post_type: "text",
        title: "Private comment thread",
        body: "Body",
        idempotency_key: "comments-routes-private-thread-1",
        visibility: "members_only",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(createdPost.status).toBe(201)
    const postBody = await json(createdPost) as { id: string }

    const topLevelComment = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts/${postBody.id}/comments`,
      {
        body: "Hello from private comments",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(topLevelComment.status).toBe(201)
    const topLevelBody = await json(topLevelComment) as { id: string }

    const reply = await requestJson(
      `http://pirate.test/comments/${topLevelBody.id}/replies`,
      {
        body: "Reply from private comments",
      },
      ctx.env,
      member.accessToken,
    )
    expect(reply.status).toBe(201)

    const memberRead = await app.request(
      `http://pirate.test/communities/${community.communityId}/posts/${postBody.id}/comments?limit=10`,
      {
        headers: {
          authorization: `Bearer ${member.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(memberRead.status).toBe(200)

    const publicTopLevel = await app.request(
      `http://pirate.test/public-comments/posts/${postBody.id}/comments?limit=10`,
      {},
      ctx.env,
    )
    expect(publicTopLevel.status).toBe(404)

    const publicReplies = await app.request(
      `http://pirate.test/public-comments/${topLevelBody.id}/replies?limit=10`,
      {},
      ctx.env,
    )
    expect(publicReplies.status).toBe(404)
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
    const postBody = await json(createdPost) as { id: string }

    const commentResponse = await requestJson(
      `http://pirate.test/communities/${community.communityId}/posts/${postBody.id}/comments`,
      {
        body: "Delete me",
      },
      ctx.env,
      creator.accessToken,
    )
    expect(commentResponse.status).toBe(201)
    const commentBody = await json(commentResponse) as { id: string }
    await setCommentMediaRefs({
      communityDbRoot: ctx.communityDbRoot,
      communityId: community.communityId,
      commentId: commentBody.id,
      mediaRefs: [{
        storage_ref: "https://media.test/deleted-comment-image.gif",
        mime_type: "image/gif",
      }],
    })

    const deleted = await Promise.resolve(app.request(
      `http://pirate.test/comments/${commentBody.id}/delete`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${creator.accessToken}`,
        },
      },
      ctx.env,
    ))
    expect(deleted.status).toBe(200)
    const deletedBody = await json(deleted) as { id: string; status: string; body: string | null; media_refs?: unknown[] }
    expect(deletedBody.id).toBe(commentBody.id)
    expect(deletedBody.status).toBe("deleted")
    expect(deletedBody.body).toBe("[deleted]")
    expect(deletedBody.media_refs).toEqual([])

    const context = await app.request(
      `http://pirate.test/comments/${commentBody.id}/context?limit=10`,
      {
        headers: {
          authorization: `Bearer ${creator.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(context.status).toBe(200)
    const contextBody = await json(context) as {
      comment: { comment: { status: string; body: string | null; media_refs?: unknown[] } }
    }
    expect(contextBody.comment.comment.status).toBe("deleted")
    expect(contextBody.comment.comment.body).toBe("[deleted]")
    expect(contextBody.comment.comment.media_refs).toEqual([])
  })
})
