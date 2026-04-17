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
  type UpdateCommunitySafetyRequestBody,
  type UpdateCommunityRulesRequestBody,
  updateCommunityGates,
  updateCommunitySafety,
  updateCommunityRules,
} from "../lib/communities/community-service"
import { badRequestError } from "../lib/errors"
import { createPost, listCommunityPosts } from "../lib/posts/post-service"
import {
  getCommunityCreationRouteContext,
  getCommunityRouteContext,
  requireJsonBody,
} from "./communities-route-helpers"
import type { CreatePostRequest } from "../types"

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
    const { actor, communityId, communityRepository } = getCommunityRouteContext(c)
    const result = await getCommunity({
      env: c.env,
      userId: actor.userId,
      communityId,
      repository: communityRepository,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/preview", async (c) => {
    const { actor, communityId, communityRepository } = getCommunityRouteContext(c)
    const result = await getCommunityPreview({
      env: c.env,
      userId: actor.userId,
      communityId,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/join-eligibility", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = getCommunityRouteContext(c)
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
    const { actor, communityId, communityRepository, userRepository } = getCommunityRouteContext(c)
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
      userRepository,
      verificationRepository,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.put("/:communityId/pending-namespace-session", async (c) => {
    const { actor, communityId, communityRepository } = getCommunityRouteContext(c)
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
    const { actor, communityId, communityRepository } = getCommunityRouteContext(c)
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

  communities.put("/:communityId/gates", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = getCommunityRouteContext(c)
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
    const { actor, communityId, communityRepository } = getCommunityRouteContext(c)
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

  communities.post("/:communityId/join", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = getCommunityRouteContext(c)
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
    const { actor, communityId, communityRepository, userRepository } = getCommunityRouteContext(c)
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
    const { actor, communityId, communityRepository } = getCommunityRouteContext(c)
    const result = await listCommunityPosts({
      env: c.env,
      userId: actor.userId,
      communityId,
      locale: c.req.query("locale") ?? null,
      limit: c.req.query("limit") ?? null,
      cursor: c.req.query("cursor") ?? null,
      flairId: c.req.query("flair_id") ?? null,
      communityRepository,
    })
    return c.json(result, 200)
  })
}
