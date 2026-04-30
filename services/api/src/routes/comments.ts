import { Hono } from "hono"
import { badRequestError, notFoundError } from "../lib/errors"
import { getProfileRepository, getUserRepository } from "../lib/auth/repositories"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import {
  authenticateAdminUserOrAgentDelegated,
  type AuthenticatedEnv,
} from "../lib/auth-middleware"
import { trackApiEvent } from "../lib/analytics/track"
import { castCommentVote, createComment, deleteComment, getCommentContext, listCommentReplies } from "../lib/comments/comment-service"
import { assertAgentDelegatedWriteMatchesActor } from "../lib/agents/agent-write-authorization"
import type { CreateCommentRequest } from "../lib/comments/comment-types"
import { writeAuditEventForEnv } from "../lib/audit"
import {
  serializeComment,
  serializeCommentContext,
  serializeCommentListResponse,
} from "../serializers/comment"
import { decodePublicCommentId } from "../lib/public-ids"

const comments = new Hono<AuthenticatedEnv>()

comments.use("*", async (c, next) => {
  const pathname = new URL(c.req.url).pathname
  const allowsAgentDelegation = c.req.method === "POST" && /^\/comments\/[^/]+\/replies$/.test(pathname)
  c.set("actor", await authenticateAdminUserOrAgentDelegated({
    allowAgentDelegated: allowsAgentDelegation,
    authorization: c.req.header("authorization"),
    env: c.env,
    xAdminAsUserId: c.req.header("x-admin-as-user-id"),
    xAdminToken: c.req.header("x-admin-token"),
  }))
  await next()
})

comments.post("/:commentId/replies", async (c) => {
  const actor = c.get("actor")
  const communityRepository = getCommunityRepository(c.env)
  const commentId = decodePublicCommentId(c.req.param("commentId"))
  const projection = await communityRepository.getCommunityCommentProjectionByCommentId(commentId)
  if (!projection) {
    throw notFoundError("Comment not found")
  }

  const body = await c.req.json<CreateCommentRequest>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid comment create payload")
  }
  if (actor.authType !== "admin") {
    assertAgentDelegatedWriteMatchesActor({ actor, body })
  }

  const result = await createComment({
    env: c.env,
    requestUrl: c.req.url,
    userId: actor.userId,
    communityId: projection.community_id,
    threadRootPostId: projection.thread_root_post_id,
    parentCommentId: commentId,
    body,
    bypassAuthorAccessChecks: actor.authType === "admin",
    userRepository: getUserRepository(c.env),
    profileRepository: getProfileRepository(c.env),
    communityRepository,
  })
  await trackApiEvent(c.env, c.req, {
    eventName: "comment_created",
    userId: actor.userId,
    communityId: projection.community_id,
    postId: projection.thread_root_post_id,
    commentId: result.comment_id,
    properties: {
      depth: result.depth,
    },
  })
  return c.json(serializeComment(result), 201)
})

comments.get("/:commentId/replies", async (c) => {
  const actor = c.get("actor")
  const result = await listCommentReplies({
    env: c.env,
    userId: actor.userId,
    commentId: decodePublicCommentId(c.req.param("commentId")),
    locale: c.req.query("locale") ?? null,
    sort: c.req.query("sort") ?? null,
    cursor: c.req.query("cursor") ?? null,
    limit: c.req.query("limit") ?? null,
    communityRepository: getCommunityRepository(c.env),
  })
  return c.json(serializeCommentListResponse(result), 200)
})

comments.get("/:commentId/context", async (c) => {
  const actor = c.get("actor")
  const result = await getCommentContext({
    env: c.env,
    userId: actor.userId,
    commentId: decodePublicCommentId(c.req.param("commentId")),
    locale: c.req.query("locale") ?? null,
    cursor: c.req.query("cursor") ?? null,
    limit: c.req.query("limit") ?? null,
    communityRepository: getCommunityRepository(c.env),
  })
  return c.json(serializeCommentContext(result), 200)
})

comments.post("/:commentId/vote", async (c) => {
  const actor = c.get("actor")
  const communityRepository = getCommunityRepository(c.env)
  const body = await c.req.json<{ value?: number }>().catch(() => null)
  if (!body || (body.value !== -1 && body.value !== 1)) {
    throw badRequestError("Vote value must be -1 or 1")
  }

  const result = await castCommentVote({
    env: c.env,
    userId: actor.userId,
    commentId: decodePublicCommentId(c.req.param("commentId")),
    value: body.value,
    bypassVoterAccessChecks: actor.authType === "admin",
    userRepository: getUserRepository(c.env),
    communityRepository,
  })
  await trackApiEvent(c.env, c.req, {
    eventName: "comment_voted",
    userId: actor.userId,
    commentId: result.comment_id,
    properties: { value: result.value },
  })
  if (actor.authType === "admin") {
    const projection = await communityRepository.getCommunityCommentProjectionByCommentId(result.comment_id)
    await writeAuditEventForEnv(c.env, {
      action: "community.admin_comment_vote_cast",
      actorId: actor.adminOverride.adminActorId,
      actorType: "operator",
      communityId: projection?.community_id ?? null,
      targetId: result.comment_id,
      targetType: "comment",
      metadata: {
        acting_user_id: actor.userId,
        value: result.value,
      },
    })
  }
  return c.json(result, 200)
})

comments.post("/:commentId/remove", async (c) => {
  const actor = c.get("actor")
  const result = await deleteComment({
    env: c.env,
    userId: actor.userId,
    commentId: decodePublicCommentId(c.req.param("commentId")),
    userRepository: getUserRepository(c.env),
    communityRepository: getCommunityRepository(c.env),
  })
  return c.json(serializeComment(result), 200)
})

export default comments
