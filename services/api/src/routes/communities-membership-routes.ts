import type { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import {
  getCommunityPreview,
} from "../lib/communities/community-preview-service"
import {
  getJoinEligibility,
} from "../lib/communities/membership/eligibility-service"
import {
  joinCommunity,
  listMembershipRequests,
  reviewMembershipRequest,
} from "../lib/communities/membership/request-service"
import {
  followCommunity,
  unfollowCommunity,
} from "../lib/communities/membership/follow-service"
import { trackApiEvent } from "../lib/analytics/track"
import { getResolvedCommunityRouteContext } from "./communities-route-helpers"

export function registerCommunityMembershipRoutes(communities: Hono<AuthenticatedEnv>): void {
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
}
