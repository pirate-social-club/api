import { Hono } from "hono"
import { badRequestError, notFoundError } from "../lib/errors"
import { getProfileRepository, getUserRepository } from "../lib/auth/repositories"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import {
  authenticateAdminUserOrAgentDelegated,
  type AuthenticatedEnv,
} from "../lib/auth-middleware"
import { trackApiEvent } from "../lib/analytics/track"
import {
  castCommentVote,
  createComment,
  deleteComment,
  getCommentContext,
  listCommentReplies,
  removeCommentAsModerator,
  setCommentReplyLock,
} from "../lib/comments/comment-service"
import { assertAgentDelegatedWriteMatchesActor } from "../lib/agents/agent-write-authorization"
import type { CreateCommentRequest } from "../lib/comments/comment-types"
import { writeAuditEventForEnv } from "../lib/audit"
import {
  serializeComment,
  serializeCommentContext,
  serializeCommentListResponse,
} from "../serializers/comment"
import { decodePublicCommentId } from "../lib/public-ids"
import { ALTCHA_HEADER, readAltchaProof } from "../lib/verification/altcha-provider"

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
    altchaProof: readAltchaProof({
      headerValue: c.req.header(ALTCHA_HEADER),
      body,
      scope: "comment_create",
      action: `comment:${c.req.param("commentId")}`,
    }),
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

  const rawCommentId = c.req.param("commentId")
  const commentId = decodePublicCommentId(rawCommentId)
  const result = await castCommentVote({
    env: c.env,
    userId: actor.userId,
    commentId,
    value: body.value,
    bypassVoterAccessChecks: actor.authType === "admin",
    altchaProof: readAltchaProof({
      headerValue: c.req.header(ALTCHA_HEADER),
      body,
      scope: "vote",
      action: `comment:${rawCommentId}:vote:${body.value}`,
    }),
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
  const commentId = decodePublicCommentId(c.req.param("commentId"))
  const result = await removeCommentAsModerator({
    env: c.env,
    userId: actor.userId,
    commentId,
    communityRepository: getCommunityRepository(c.env),
  })
  await writeAuditEventForEnv(c.env, {
    action: "community.comment_removed_by_moderator",
    actorId: actor.userId,
    actorType: "user",
    communityId: result.community_id,
    targetId: commentId,
    targetType: "comment",
    metadata: {
      removed_at: result.updated_at,
    },
  })
  return c.json(serializeComment(result), 200)
})

comments.post("/:commentId/delete", async (c) => {
  const actor = c.get("actor")
  const commentId = decodePublicCommentId(c.req.param("commentId"))
  const result = await deleteComment({
    env: c.env,
    userId: actor.userId,
    commentId,
    userRepository: getUserRepository(c.env),
    communityRepository: getCommunityRepository(c.env),
  })
  await writeAuditEventForEnv(c.env, {
    action: "community.comment_deleted_by_author",
    actorId: actor.userId,
    actorType: "user",
    communityId: result.community_id,
    targetId: commentId,
    targetType: "comment",
    metadata: {
      deleted_at: result.updated_at,
    },
  })
  return c.json(serializeComment(result), 200)
})

comments.post("/:commentId/replies-lock", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json().catch(() => null) as { locked?: boolean; reason?: string | null } | null
  if (!body || typeof body !== "object") {
    throw badRequestError("Invalid reply lock payload")
  }
  const commentId = decodePublicCommentId(c.req.param("commentId"))
  const result = await setCommentReplyLock({
    env: c.env,
    userId: actor.userId,
    commentId,
    locked: body.locked !== false,
    reason: body.reason ?? null,
    communityRepository: getCommunityRepository(c.env),
  })
  await writeAuditEventForEnv(c.env, {
    action: result.replies_locked ? "community.comment_replies_locked_by_moderator" : "community.comment_replies_unlocked_by_moderator",
    actorId: actor.userId,
    actorType: "user",
    communityId: result.community_id,
    targetId: commentId,
    targetType: "comment",
    metadata: {
      locked: result.replies_locked,
      reason: result.replies_lock_reason,
    },
  })
  return c.json(serializeComment(result), 200)
})

export default comments
