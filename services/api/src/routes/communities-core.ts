import { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import {
  attachNamespaceToCommunity,
  createCommunity,
  followCommunity,
  getCommunity,
  getCommunityPreview,
  getJoinEligibility,
  listMembershipRequests,
  joinCommunity,
  reviewMembershipRequest,
  setPendingNamespaceVerificationSession,
  type CreateCommunityRequestBody,
  type UpdateCommunityRequestBody,
  type UpdateCommunityGatesRequestBody,
  type UpdateCommunityLabelPolicyRequestBody,
  type UpdateCommunityReferenceLinksRequestBody,
  type UpdateCommunitySafetyRequestBody,
  type UpdateCommunityRulesRequestBody,
  type UpdateCommunityDonationPolicyRequestBody,
  updateCommunity,
  updateCommunityGates,
  updateCommunityLabelPolicy,
  updateCommunityReferenceLinks,
  updateCommunitySafety,
  updateCommunityRules,
  updateCommunityDonationPolicy,
  unfollowCommunity,
  getCommunityDonationPolicy,
  resolveCommunityDonationPartner,
} from "../lib/communities/community-service"
import { authError, badRequestError } from "../lib/errors"
import {
  getCommunityMachineAccessPolicy,
  updateCommunityMachineAccessPolicy,
  type CommunityMachineAccessPolicyPatch,
} from "../lib/communities/community-machine-access-service"
import { createPost, listCommunityPosts } from "../lib/posts/post-service"
import { createComment, listPostComments } from "../lib/comments/comment-service"
import { assertAgentDelegatedWriteMatchesActor } from "../lib/agents/agent-write-authorization"
import { trackApiEvent } from "../lib/analytics/track"
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
  communities.get("/admin/health", async (c) => {
    const actor = c.get("actor")
    if (actor.authType !== "admin") {
      throw authError("Admin authentication required")
    }
    return c.json({
      ok: true,
      mode: "admin",
      admin_actor_id: actor.adminOverride.adminActorId,
      acting_user_id: actor.userId,
      scope: actor.adminOverride.scope,
    }, 200)
  })

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
    await trackApiEvent(c.env, c.req, {
      eventName: "community_create_submitted",
      userId: actor.userId,
      communityId: result.community.community_id,
      properties: {
        membership_mode: result.community.membership_mode,
        namespace_attached: Boolean(result.community.namespace_verification_id),
      },
    })
    await trackApiEvent(c.env, c.req, {
      eventName: "community_provisioning_requested",
      userId: actor.userId,
      communityId: result.community.community_id,
      properties: {
        job_status: result.job.status,
      },
    })
    if (result.job.status === "succeeded" || result.job.status === "failed") {
      await trackApiEvent(c.env, c.req, {
        eventName: result.job.status === "succeeded" ? "community_provisioning_succeeded" : "community_provisioning_failed",
        userId: actor.userId,
        communityId: result.community.community_id,
        properties: {
          failure_code: result.job.error_code ?? null,
        },
      })
    }
    return c.json(result, 202)
  })

  communities.get("/:communityId", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await getCommunity({
      env: c.env,
      userId: actor.userId,
      communityId,
      locale: c.req.query("locale") ?? null,
      repository: communityRepository,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/machine-access-policy", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await getCommunityMachineAccessPolicy({
      env: c.env,
      communityRepository,
      communityId,
      userId: actor.userId,
    })
    return c.json(result, 200)
  })

  communities.patch("/:communityId/machine-access-policy", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await c.req.json<CommunityMachineAccessPolicyPatch>().catch(() => null)
    const result = await updateCommunityMachineAccessPolicy({
      env: c.env,
      communityRepository,
      communityId,
      userId: actor.userId,
      body,
    })
    return c.json(result, 200)
  })

  communities.patch("/:communityId", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await c.req.json<UpdateCommunityRequestBody>().catch(() => null)

    const result = await updateCommunity({
      env: c.env,
      userId: actor.userId,
      communityId,
      body,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/preview", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await getCommunityPreview({
      env: c.env,
      userId: actor.userId,
      communityId,
      locale: c.req.query("locale") ?? null,
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

  communities.patch("/:communityId/labels", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await c.req.json<UpdateCommunityLabelPolicyRequestBody>().catch(() => null)

    const result = await updateCommunityLabelPolicy({
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
    const { actor, communityId, communityRepository, userRepository, profileRepository } = await getResolvedCommunityRouteContext(c)
    const body = await c.req.json<{ note?: string | null }>().catch(() => null)
    const result = await joinCommunity({
      env: c.env,
      userId: actor.userId,
      communityId,
      note: body?.note ?? null,
      userRepository,
      profileRepository,
      communityRepository,
    })
    if (result.status === "joined") {
      await trackApiEvent(c.env, c.req, {
        eventName: "community_join_succeeded",
        userId: actor.userId,
        communityId,
      })
    }
    return c.json(result, 200)
  })

  communities.get("/:communityId/membership-requests", async (c) => {
    const { actor, communityId, communityRepository, profileRepository } = await getResolvedCommunityRouteContext(c)
    const limitRaw = Number(c.req.query("limit") ?? "")
    const result = await listMembershipRequests({
      env: c.env,
      userId: actor.userId,
      communityId,
      cursor: c.req.query("cursor") ?? null,
      limit: Number.isFinite(limitRaw) ? Math.trunc(limitRaw) : undefined,
      communityRepository,
      profileRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/membership-requests/:requestId/approve", async (c) => {
    const { actor, communityId, communityRepository, profileRepository } = await getResolvedCommunityRouteContext(c)
    const result = await reviewMembershipRequest({
      env: c.env,
      userId: actor.userId,
      communityId,
      requestId: c.req.param("requestId"),
      decision: "approved",
      communityRepository,
      profileRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/membership-requests/:requestId/reject", async (c) => {
    const { actor, communityId, communityRepository, profileRepository } = await getResolvedCommunityRouteContext(c)
    const result = await reviewMembershipRequest({
      env: c.env,
      userId: actor.userId,
      communityId,
      requestId: c.req.param("requestId"),
      decision: "rejected",
      communityRepository,
      profileRepository,
    })
    return c.json(result, 200)
  })

  communities.put("/:communityId/follow", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await followCommunity({
      env: c.env,
      userId: actor.userId,
      communityId,
      communityRepository,
    })
    if (result.following) {
      await trackApiEvent(c.env, c.req, {
        eventName: "community_followed",
        userId: actor.userId,
        communityId,
      })
    }
    return c.json(result, 200)
  })

  communities.delete("/:communityId/follow", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await unfollowCommunity({
      env: c.env,
      userId: actor.userId,
      communityId,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/posts", async (c) => {
    const { actor, communityId, communityRepository, userRepository, profileRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CreatePostRequest>(c, "Invalid post create payload")
    assertAgentDelegatedWriteMatchesActor({ actor, body })
    const result = await createPost({
      env: c.env,
      requestUrl: c.req.url,
      userId: actor.userId,
      communityId,
      body,
      userRepository,
      profileRepository,
      communityRepository,
    })
    await trackApiEvent(c.env, c.req, {
      eventName: "post_created",
      userId: actor.userId,
      communityId,
      postId: result.post_id,
      idempotencyKey: body.idempotency_key ?? null,
      properties: {
        post_type: result.post_type,
        status: result.status,
      },
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
    const { actor, communityId, communityRepository, userRepository, profileRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CreateCommentRequest>(c, "Invalid comment create payload")
    assertAgentDelegatedWriteMatchesActor({ actor, body })
    const result = await createComment({
      env: c.env,
      requestUrl: c.req.url,
      userId: actor.userId,
      communityId,
      threadRootPostId: c.req.param("postId"),
      body,
      userRepository,
      profileRepository,
      communityRepository,
    })
    await trackApiEvent(c.env, c.req, {
      eventName: "comment_created",
      userId: actor.userId,
      communityId,
      postId: c.req.param("postId"),
      commentId: result.comment_id,
      properties: {
        depth: result.depth,
      },
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
