import { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import { badRequestError } from "../lib/errors"
import {
  updateCommunityGates,
  updateCommunityLabelPolicy,
  updateCommunityReferenceLinks,
  updateCommunityRules,
  updateCommunitySafety,
  type UpdateCommunityGatesRequestBody,
  type UpdateCommunityLabelPolicyRequestBody,
  type UpdateCommunityReferenceLinksRequestBody,
  type UpdateCommunityRulesRequestBody,
  type UpdateCommunitySafetyRequestBody,
} from "../lib/communities/create/service"
import {
  getCommunityMachineAccessPolicy,
  updateCommunityMachineAccessPolicy,
  type CommunityMachineAccessPolicyPatch,
} from "../lib/communities/community-machine-access-service"
import {
  getResolvedCommunityRouteContext,
  requireJsonBody,
} from "./communities-route-helpers"
import { serializeCommunity } from "../serializers/community"

export function registerCommunitySettingsRoutes(communities: Hono<AuthenticatedEnv>): void {
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

  communities.post("/:communityId/machine-access-policy", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CommunityMachineAccessPolicyPatch>(c, "Invalid machine access policy payload")
    const result = await updateCommunityMachineAccessPolicy({
      env: c.env,
      communityRepository,
      communityId,
      userId: actor.userId,
      body,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/rules", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<UpdateCommunityRulesRequestBody>(c, "Invalid community rules payload")
    if (!body || !Array.isArray(body.rules)) {
      throw badRequestError("Invalid community rules payload")
    }

    const result = await updateCommunityRules({
      env: c.env,
      actor,
      communityId,
      body,
      communityRepository,
    })
    return c.json(serializeCommunity(result), 200)
  })

  communities.post("/:communityId/reference-links", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<UpdateCommunityReferenceLinksRequestBody>(c, "Invalid reference links payload")

    const result = await updateCommunityReferenceLinks({
      env: c.env,
      actor,
      communityId,
      body,
      communityRepository,
    })
    return c.json(serializeCommunity(result), 200)
  })

  communities.post("/:communityId/labels", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<UpdateCommunityLabelPolicyRequestBody>(c, "Invalid community label policy payload")

    const result = await updateCommunityLabelPolicy({
      env: c.env,
      actor,
      communityId,
      body,
      communityRepository,
    })
    return c.json(serializeCommunity(result), 200)
  })

  communities.post("/:communityId/gates", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<UpdateCommunityGatesRequestBody>(c, "Invalid community gates payload")

    const result = await updateCommunityGates({
      env: c.env,
      actor,
      communityId,
      body,
      communityRepository,
      userRepository,
    })
    return c.json(serializeCommunity(result), 200)
  })

  communities.post("/:communityId/safety", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<UpdateCommunitySafetyRequestBody>(c, "Invalid community safety payload")

    const result = await updateCommunitySafety({
      env: c.env,
      actor,
      communityId,
      body,
      communityRepository,
    })
    return c.json(serializeCommunity(result), 200)
  })
}
