import type { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import {
  attachNamespaceToCommunity,
  createCommunity,
} from "../lib/communities/provisioning/service"
import type { CreateCommunityRequestBody } from "../lib/communities/create/validation"
import {
  getCommunity,
  setPendingNamespaceVerificationSession,
} from "../lib/communities/membership/read-service"
import { badRequestError } from "../lib/errors"
import { trackApiEvent } from "../lib/analytics/track"
import {
  getCommunityCreationRouteContext,
  getResolvedCommunityRouteContext,
  requireJsonBody,
} from "./communities-route-helpers"

export function registerCommunityCreateRoutes(communities: Hono<AuthenticatedEnv>): void {
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
}
