import { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import {
  attachNamespaceToCommunity,
  createCommunity,
  getCommunity,
  getCommunityPreview,
  getJoinEligibility,
  joinCommunity,
  setPendingNamespaceVerificationSession,
  type CreateCommunityRequestBody,
  type UpdateCommunityGatesRequestBody,
  type UpdateCommunityReferenceLinksRequestBody,
  type UpdateCommunitySafetyRequestBody,
  type UpdateCommunityRulesRequestBody,
  type UpdateCommunityDonationPolicyRequestBody,
  updateCommunityGates,
  updateCommunityReferenceLinks,
  updateCommunitySafety,
  updateCommunityRules,
  updateCommunityDonationPolicy,
  getCommunityDonationPolicy,
  resolveCommunityDonationPartner,
} from "../lib/communities/community-service"
import { badRequestError } from "../lib/errors"
import { createPost, listCommunityPosts } from "../lib/posts/post-service"
import { createComment, listPostComments } from "../lib/comments/comment-service"
import {
  getModerationCaseDetail,
  listCommunityModerationCases,
  reportComment,
  reportPost,
  resolveModerationCaseWithAction,
} from "../lib/moderation/moderation-service"
import type { CreateModerationActionRequest, CreateUserReportRequest } from "../lib/moderation/moderation-types"
import {
  getCommunityCreationRouteContext,
  getResolvedCommunityRouteContext,
  requireJsonBody,
} from "./communities-route-helpers"
import type { CreatePostRequest } from "../types"
import type { CreateCommentRequest } from "../lib/comments/comment-types"

export function registerCommunityCoreRoutes(communities: Hono<AuthenticatedEnv>): void {
  communities.post("/", async (c) => {
    const { actor, communityRepository, userRepository, verificationRepository } = getCommunityCreationRouteContext(c)
    const body = await requireJsonBody<CreateCommunityRequestBody>(c, "Invalid community create payload")

    const result = await createCommunity({
      env: c.env,
      userId: actor.userId,
      body,
      userRepository,
      verificationRepository,
      communityRepository,
    })
    return c.json(result, 202)
  })

  communities.get("/:communityId", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await getCommunity({
      env: c.env,
      userId: actor.userId,
      communityId,
      repository: communityRepository,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/preview", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await getCommunityPreview({
      env: c.env,
      userId: actor.userId,
      communityId,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/join-eligibility", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    const result = await getJoinEligibility({
      env: c.env,
      userId: actor.userId,
      communityId,
      userRepository,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/namespace", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const { verificationRepository } = getCommunityCreationRouteContext(c)
    const body = await c.req.json<{ namespace_verification_id?: string | null }>().catch(() => null)
    const namespaceVerificationId = body?.namespace_verification_id?.trim()
    if (!namespaceVerificationId) {
      throw badRequestError("namespace_verification_id is required")
    }

    const result = await attachNamespaceToCommunity({
      env: c.env,
      userId: actor.userId,
      communityId,
      namespaceVerificationId,
      verificationRepository,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.put("/:communityId/pending-namespace-session", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await c.req.json<{ namespace_verification_session_id?: string | null }>().catch(() => null)
    const sessionId = typeof body?.namespace_verification_session_id === "string"
      ? body.namespace_verification_session_id.trim() || null
      : null

    const result = await setPendingNamespaceVerificationSession({
      env: c.env,
      userId: actor.userId,
      communityId,
      sessionId,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.put("/:communityId/rules", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await c.req.json<UpdateCommunityRulesRequestBody>().catch(() => null)
    if (!body || !Array.isArray(body.rules)) {
      throw badRequestError("Invalid community rules payload")
    }

    const result = await updateCommunityRules({
      env: c.env,
      userId: actor.userId,
      communityId,
      body,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.put("/:communityId/reference-links", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await c.req.json<UpdateCommunityReferenceLinksRequestBody>().catch(() => null)

    const result = await updateCommunityReferenceLinks({
      env: c.env,
      userId: actor.userId,
      communityId,
      body,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.put("/:communityId/gates", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    const body = await c.req.json<UpdateCommunityGatesRequestBody>().catch(() => null)

    const result = await updateCommunityGates({
      env: c.env,
      userId: actor.userId,
      communityId,
      body,
      communityRepository,
      userRepository,
    })
    return c.json(result, 200)
  })

  communities.put("/:communityId/safety", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await c.req.json<UpdateCommunitySafetyRequestBody>().catch(() => null)

    const result = await updateCommunitySafety({
      env: c.env,
      userId: actor.userId,
      communityId,
      body,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/donation-policy", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await getCommunityDonationPolicy({
      env: c.env,
      userId: actor.userId,
      communityId,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/donation-policy/resolve", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await c.req.json<{ endaoment_url?: string | null }>().catch(() => null)
    if (!body?.endaoment_url?.trim()) {
      throw badRequestError("Invalid donation partner resolve payload")
    }

    const result = await resolveCommunityDonationPartner({
      communityId,
      communityRepository,
      endaomentUrl: body.endaoment_url,
      env: c.env,
      userId: actor.userId,
    })
    return c.json(result, 200)
  })

  communities.patch("/:communityId/donation-policy", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await c.req.json<UpdateCommunityDonationPolicyRequestBody>().catch(() => null)
    if (!body || !body.donation_policy_mode) {
      throw badRequestError("Invalid donation policy payload")
    }

    const result = await updateCommunityDonationPolicy({
      env: c.env,
      userId: actor.userId,
      communityId,
      body,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/join", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    const result = await joinCommunity({
      env: c.env,
      userId: actor.userId,
      communityId,
      userRepository,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/posts", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CreatePostRequest>(c, "Invalid post create payload")
    const result = await createPost({
      env: c.env,
      userId: actor.userId,
      communityId,
      body,
      userRepository,
      communityRepository,
    })
    return c.json(result, result.status === "published" ? 201 : 202)
  })

  communities.get("/:communityId/posts", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await listCommunityPosts({
      env: c.env,
      userId: actor.userId,
      communityId,
      locale: c.req.query("locale") ?? null,
      limit: c.req.query("limit") ?? null,
      cursor: c.req.query("cursor") ?? null,
      flairId: c.req.query("flair_id") ?? null,
      sort: c.req.query("sort") ?? null,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/posts/:postId/comments", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CreateCommentRequest>(c, "Invalid comment create payload")
    const result = await createComment({
      env: c.env,
      userId: actor.userId,
      communityId,
      threadRootPostId: c.req.param("postId"),
      body,
      userRepository,
      communityRepository,
    })
    return c.json(result, 201)
  })

  communities.get("/:communityId/posts/:postId/comments", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await listPostComments({
      env: c.env,
      userId: actor.userId,
      communityId,
      threadRootPostId: c.req.param("postId"),
      locale: c.req.query("locale") ?? null,
      sort: c.req.query("sort") ?? null,
      cursor: c.req.query("cursor") ?? null,
      limit: c.req.query("limit") ?? null,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/posts/:postId/reports", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CreateUserReportRequest>(c, "Invalid user report payload")
    const result = await reportPost({
      env: c.env,
      userId: actor.userId,
      communityId,
      postId: c.req.param("postId"),
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
      commentId: c.req.param("commentId"),
      body,
      userRepository,
      communityRepository,
    })
    return c.json(result, 201)
  })

  communities.get("/:communityId/moderation/cases", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await listCommunityModerationCases({
      env: c.env,
      userId: actor.userId,
      communityId,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/moderation/cases/:moderationCaseId", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await getModerationCaseDetail({
      env: c.env,
      userId: actor.userId,
      communityId,
      moderationCaseId: c.req.param("moderationCaseId"),
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
      moderationCaseId: c.req.param("moderationCaseId"),
      body,
      userRepository,
      communityRepository,
    })
    return c.json(result, 200)
  })
}
