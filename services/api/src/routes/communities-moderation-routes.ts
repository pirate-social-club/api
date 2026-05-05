import { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import {
  getModerationCaseDetail,
  listCommunityModerationCases,
  reportComment,
  reportPost,
  resolveModerationCaseWithAction,
} from "../lib/moderation/moderation-service"
import type { CreateModerationActionRequest, CreateUserReportRequest } from "../lib/moderation/moderation-types"
import {
  getResolvedCommunityRouteContext,
  requireJsonBody,
} from "./communities-route-helpers"
import { decodePublicCommentId, decodePublicModerationCaseId, decodePublicPostId } from "../lib/public-ids"

export function registerCommunityModerationRoutes(communities: Hono<AuthenticatedEnv>): void {
  communities.post("/:communityId/posts/:postId/reports", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CreateUserReportRequest>(c, "Invalid user report payload")
    const result = await reportPost({
      env: c.env,
      userId: actor.userId,
      communityId,
      postId: decodePublicPostId(c.req.param("postId")),
      body,
      userRepository,
      communityRepository,
    })
    return c.json(result, 201)
  })

  communities.post("/:communityId/comments/:commentId/reports", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CreateUserReportRequest>(c, "Invalid user report payload")
    const result = await reportComment({
      env: c.env,
      userId: actor.userId,
      communityId,
      commentId: decodePublicCommentId(c.req.param("commentId")),
      body,
      userRepository,
      communityRepository,
    })
    return c.json(result, 201)
  })

  communities.get("/:communityId/moderation/cases", async (c) => {
    const { actor, communityId, communityRepository, profileRepository } = await getResolvedCommunityRouteContext(c)
    const result = await listCommunityModerationCases({
      env: c.env,
      userId: actor.userId,
      communityId,
      communityRepository,
      profileRepository,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/moderation/cases/:moderationCaseId", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await getModerationCaseDetail({
      env: c.env,
      userId: actor.userId,
      communityId,
      moderationCaseId: decodePublicModerationCaseId(c.req.param("moderationCaseId")),
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/moderation/cases/:moderationCaseId/actions", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CreateModerationActionRequest>(c, "Invalid moderation action payload")
    const result = await resolveModerationCaseWithAction({
      env: c.env,
      userId: actor.userId,
      communityId,
      moderationCaseId: decodePublicModerationCaseId(c.req.param("moderationCaseId")),
      body,
      userRepository,
      communityRepository,
    })
    return c.json(result, 200)
  })
}
