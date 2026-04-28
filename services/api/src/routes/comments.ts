import { Hono } from "hono"
import { badRequestError, notFoundError } from "../lib/errors"
import { getProfileRepository, getUserRepository } from "../lib/auth/repositories"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import {
  authenticateAdminOrUser,
  authenticateAdminToken,
  authenticateAgentDelegatedToken,
  authenticateUserToken,
  requireBearerToken,
  type AuthenticatedEnv,
} from "../lib/auth-middleware"
import { trackApiEvent } from "../lib/analytics/track"
import { castCommentVote, createComment, deleteComment, getCommentContext, listCommentReplies } from "../lib/comments/comment-service"
import { assertAgentDelegatedWriteMatchesActor } from "../lib/agents/agent-write-authorization"
import type { CreateCommentRequest } from "../lib/comments/comment-types"

const comments = new Hono<AuthenticatedEnv>()

comments.use("*", async (c, next) => {
  const pathname = new URL(c.req.url).pathname
  const allowsAgentDelegation = c.req.method === "POST" && /^\/comments\/[^/]+\/replies$/.test(pathname)
  if (allowsAgentDelegation) {
    const adminActor = authenticateAdminToken({
      env: c.env,
      token: c.req.header("x-admin-token"),
      asUserId: c.req.header("x-admin-as-user-id"),
    })
    if (adminActor) {
      c.set("actor", adminActor)
      await next()
      return
    }

    const token = requireBearerToken(c.req.header("authorization"))
    try {
      c.set("actor", await authenticateUserToken({ env: c.env, token }))
    } catch {
      c.set("actor", await authenticateAgentDelegatedToken({ env: c.env, token }))
    }
    await next()
    return
  }

  return authenticateAdminOrUser(c, next)
})

comments.post("/:commentId/replies", async (c) => {
  const actor = c.get("actor")
  const communityRepository = getCommunityRepository(c.env)
  const projection = await communityRepository.getCommunityCommentProjectionByCommentId(c.req.param("commentId"))
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
    parentCommentId: c.req.param("commentId"),
    body,
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
  return c.json(result, 201)
})

comments.get("/:commentId/replies", async (c) => {
  const actor = c.get("actor")
  const result = await listCommentReplies({
    env: c.env,
    userId: actor.userId,
    commentId: c.req.param("commentId"),
    locale: c.req.query("locale") ?? null,
    sort: c.req.query("sort") ?? null,
    cursor: c.req.query("cursor") ?? null,
    limit: c.req.query("limit") ?? null,
    communityRepository: getCommunityRepository(c.env),
  })
  return c.json(result, 200)
})

comments.get("/:commentId/context", async (c) => {
  const actor = c.get("actor")
  const result = await getCommentContext({
    env: c.env,
    userId: actor.userId,
    commentId: c.req.param("commentId"),
    locale: c.req.query("locale") ?? null,
    cursor: c.req.query("cursor") ?? null,
    limit: c.req.query("limit") ?? null,
    communityRepository: getCommunityRepository(c.env),
  })
  return c.json(result, 200)
})

comments.post("/:commentId/vote", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ value?: number }>().catch(() => null)
  if (!body || (body.value !== -1 && body.value !== 1)) {
    throw badRequestError("Vote value must be -1 or 1")
  }

  const result = await castCommentVote({
    env: c.env,
    userId: actor.userId,
    commentId: c.req.param("commentId"),
    value: body.value,
    userRepository: getUserRepository(c.env),
    communityRepository: getCommunityRepository(c.env),
  })
  await trackApiEvent(c.env, c.req, {
    eventName: "comment_voted",
    userId: actor.userId,
    commentId: result.comment_id,
    properties: { value: result.value },
  })
  return c.json(result, 200)
})

comments.delete("/:commentId", async (c) => {
  const actor = c.get("actor")
  const result = await deleteComment({
    env: c.env,
    userId: actor.userId,
    commentId: c.req.param("commentId"),
    userRepository: getUserRepository(c.env),
    communityRepository: getCommunityRepository(c.env),
  })
  return c.json(result, 200)
})

export default comments
