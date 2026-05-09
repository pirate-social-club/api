import { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import {
  getCommunityPreview,
} from "../lib/communities/community-preview-service"
import { serializeCommunityPreview } from "../serializers/community"
import {
  followCommunity,
  unfollowCommunity,
} from "../lib/communities/membership/follow-service"
import { getJoinEligibility } from "../lib/communities/membership/eligibility-service"
import {
  joinCommunity,
  listMembershipRequests,
  reviewMembershipRequest,
} from "../lib/communities/membership/request-service"
import { trackApiEvent } from "../lib/analytics/track"
import {
  getResolvedCommunityRouteContext,
  optionalJsonBody,
} from "./communities-route-helpers"
import { decodePublicMembershipRequestId, publicCommunityId } from "../lib/public-ids"
import { ALTCHA_HEADER, readAltchaProof } from "../lib/verification/altcha-provider"

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
    return c.json(serializeCommunityPreview(result), 200)
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
    const body = await optionalJsonBody<{ note?: string | null }>(c, "Invalid community join payload")
    const result = await joinCommunity({
      env: c.env,
      userId: actor.userId,
      communityId,
      note: body?.note ?? null,
      bypassMembershipGateChecks: actor.authType === "admin",
      altchaProof: readAltchaProof({
        headerValue: c.req.header(ALTCHA_HEADER),
        body,
        scope: "community_join",
        action: `community:${publicCommunityId(communityId)}`,
      }),
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
      requestId: decodePublicMembershipRequestId(c.req.param("requestId")),
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
      requestId: decodePublicMembershipRequestId(c.req.param("requestId")),
      decision: "rejected",
      communityRepository,
      profileRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/follow", async (c) => {
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

  communities.post("/:communityId/unfollow", async (c) => {
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
