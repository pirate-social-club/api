import { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import {
  claimCommunityHandle,
  getCommunityHandlePolicy,
  getMyCommunityHandle,
  quoteCommunityHandle,
  updateCommunityHandlePolicy,
} from "../lib/communities/handles/handle-claim-service"
import {
  getResolvedCommunityRouteContext,
  requireJsonBody,
} from "./communities-route-helpers"
import type {
  CommunityHandleClaimRequest,
  CommunityHandleQuoteRequest,
  UpdateCommunityHandlePolicyRequest,
} from "../types"

export function registerCommunityHandleRoutes(communities: Hono<AuthenticatedEnv>): void {
  communities.get("/:communityId/handles/me", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await getMyCommunityHandle({
      env: c.env,
      userId: actor.userId,
      communityId,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/handle-policy", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await getCommunityHandlePolicy({
      env: c.env,
      userId: actor.userId,
      communityId,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/handle-policy", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<UpdateCommunityHandlePolicyRequest>(c, "Invalid community handle policy payload")
    const result = await updateCommunityHandlePolicy({
      env: c.env,
      userId: actor.userId,
      communityId,
      body,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/handles/quote", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CommunityHandleQuoteRequest>(c, "Invalid community handle quote payload")
    const result = await quoteCommunityHandle({
      env: c.env,
      userId: actor.userId,
      communityId,
      body,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/handles/claim", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CommunityHandleClaimRequest>(c, "Invalid community handle claim payload")
    const result = await claimCommunityHandle({
      env: c.env,
      userId: actor.userId,
      communityId,
      body,
      userRepository,
      communityRepository,
    })
    return c.json(result, 200)
  })
}
