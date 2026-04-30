import { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import { badRequestError } from "../lib/errors"
import {
  attachNamespaceToCommunity,
  createCommunity,
  getCommunityDonationPolicy,
  resolveCommunityDonationPartner,
  updateCommunity,
  updateCommunityDonationPolicy,
  type CreateCommunityRequestBody,
  type UpdateCommunityDonationPolicyRequestBody,
  type UpdateCommunityRequestBody,
} from "../lib/communities/create/service"
import {
  getCommunity,
  setPendingNamespaceVerificationSession,
} from "../lib/communities/membership/community-read-service"
import { trackApiEvent } from "../lib/analytics/track"
import {
  getCommunityCreationRouteContext,
  getResolvedCommunityRouteContext,
  requireJsonBody,
} from "./communities-route-helpers"
import {
  serializeCommunity,
} from "../serializers/community"
import {
  decodePublicNamespaceVerificationId,
  decodePublicNamespaceVerificationSessionId,
} from "../lib/public-ids"

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
      communityId: result.community.id.replace(/^com_/, ""),
      properties: {
        membership_mode: result.community.membership_mode,
        namespace_attached: Boolean(result.community.namespace_verification),
      },
    })
    await trackApiEvent(c.env, c.req, {
      eventName: "community_provisioning_requested",
      userId: actor.userId,
      communityId: result.community.id.replace(/^com_/, ""),
      properties: {
        job_status: result.job.status,
      },
    })
    if (result.job.status === "succeeded" || result.job.status === "failed") {
      await trackApiEvent(c.env, c.req, {
        eventName: result.job.status === "succeeded" ? "community_provisioning_succeeded" : "community_provisioning_failed",
        userId: actor.userId,
        communityId: result.community.id.replace(/^com_/, ""),
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
    return c.json(serializeCommunity(result), 200)
  })

  communities.post("/:communityId", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<UpdateCommunityRequestBody>(c, "Invalid community update payload")

    const result = await updateCommunity({
      env: c.env,
      actor,
      communityId,
      body,
      communityRepository,
    })
    return c.json(serializeCommunity(result), 200)
  })

  communities.post("/:communityId/namespace", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const { verificationRepository } = getCommunityCreationRouteContext(c)
    const body = await requireJsonBody<{
      namespace_verification?: string | null
    }>(c, "Invalid namespace attach payload")
    const publicNamespaceVerificationId = body?.namespace_verification?.trim()
    const namespaceVerificationId = publicNamespaceVerificationId
      ? decodePublicNamespaceVerificationId(publicNamespaceVerificationId)
      : null
    if (!namespaceVerificationId) {
      throw badRequestError("namespace_verification is required")
    }

    const result = await attachNamespaceToCommunity({
      env: c.env,
      userId: actor.userId,
      communityId,
      namespaceVerificationId,
      verificationRepository,
      communityRepository,
    })
    return c.json(serializeCommunity(result), 200)
  })

  communities.post("/:communityId/pending-namespace-session", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<{ namespace_verification_session_id?: string | null }>(c, "Invalid pending namespace session payload")
    const sessionId = typeof body?.namespace_verification_session_id === "string"
      ? decodePublicNamespaceVerificationSessionId(body.namespace_verification_session_id.trim()) || null
      : null

    const result = await setPendingNamespaceVerificationSession({
      env: c.env,
      userId: actor.userId,
      communityId,
      sessionId,
      communityRepository,
    })
    return c.json(serializeCommunity(result), 200)
  })

  communities.get("/:communityId/donation-policy", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await getCommunityDonationPolicy({
      env: c.env,
      actor,
      communityId,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/donation-policy/resolve", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<{ endaoment_url?: string | null }>(c, "Invalid donation partner resolve payload")
    if (!body?.endaoment_url?.trim()) {
      throw badRequestError("Invalid donation partner resolve payload")
    }

    const result = await resolveCommunityDonationPartner({
      communityId,
      communityRepository,
      endaomentUrl: body.endaoment_url,
      env: c.env,
      actor,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/donation-policy", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<UpdateCommunityDonationPolicyRequestBody>(c, "Invalid donation policy payload")
    if (!body || !body.donation_policy_mode) {
      throw badRequestError("Invalid donation policy payload")
    }

    const result = await updateCommunityDonationPolicy({
      env: c.env,
      actor,
      communityId,
      body,
      communityRepository,
    })
    return c.json(result, 200)
  })
}
