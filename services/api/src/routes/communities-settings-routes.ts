import type { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import type {
  UpdateCommunityDonationPolicyRequestBody,
  UpdateCommunityGatesRequestBody,
  UpdateCommunityLabelPolicyRequestBody,
  UpdateCommunityReferenceLinksRequestBody,
  UpdateCommunityRequestBody,
  UpdateCommunityRulesRequestBody,
  UpdateCommunitySafetyRequestBody,
} from "../lib/communities/create/update-validation"
import {
  getCommunityMachineAccessPolicy,
  updateCommunityMachineAccessPolicy,
  type CommunityMachineAccessPolicyPatch,
} from "../lib/communities/community-machine-access-service"
import {
  getCommunityDonationPolicy,
  resolveCommunityDonationPartner,
  updateCommunityDonationPolicy,
} from "../lib/communities/community-donation-settings-service"
import { updateCommunity } from "../lib/communities/community-profile-settings-service"
import { updateCommunityGates } from "../lib/communities/community-gate-settings-service"
import {
  updateCommunityLabelPolicy,
  updateCommunityReferenceLinks,
} from "../lib/communities/community-link-label-settings-service"
import { updateCommunitySafety } from "../lib/communities/community-safety-settings-service"
import { updateCommunityRules } from "../lib/communities/community-rule-settings-service"
import { badRequestError } from "../lib/errors"
import { getResolvedCommunityRouteContext } from "./communities-route-helpers"

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
}
