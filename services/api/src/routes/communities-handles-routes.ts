import { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import {
  claimCommunityHandle,
  quoteCommunityHandle,
  reserveCommunityHandle,
  revokeCommunityHandle,
  updateCommunityHandlePolicy,
} from "../lib/communities/handles/handle-claim-service"
import {
  getCommunityHandlePolicy,
  getCommunityHandleStatus,
  getMyCommunityHandle,
  listCommunityHandles,
} from "../lib/communities/handles/handle-read-service"
import {
  getResolvedCommunityRouteContext,
  requireJsonBody,
} from "./communities-route-helpers"
import type {
  CommunityHandleClaimRequest,
  CommunityHandleQuoteRequest,
  CommunityHandleReserveRequest,
  CommunityHandleRevokeRequest,
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

  communities.get("/:communityId/handles/status", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await getCommunityHandleStatus({
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

  communities.get("/:communityId/handles", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await listCommunityHandles({
      env: c.env,
      userId: actor.userId,
      communityId,
      status: c.req.query("status"),
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

  communities.post("/:communityId/handles/reserve", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CommunityHandleReserveRequest>(c, "Invalid community handle reserve payload")
    const result = await reserveCommunityHandle({
      env: c.env,
      userId: actor.userId,
      communityId,
      body,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/handles/quote", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CommunityHandleQuoteRequest>(c, "Invalid community handle quote payload")
    const result = await quoteCommunityHandle({
      env: c.env,
      userId: actor.userId,
      communityId,
      body,
      userRepository,
      communityRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/handles/:handleId/revoke", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CommunityHandleRevokeRequest>(c, "Invalid community handle revoke payload")
    const result = await revokeCommunityHandle({
      env: c.env,
      userId: actor.userId,
      communityId,
      handleId: c.req.param("handleId"),
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
