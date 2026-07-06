import { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import {
  applyRightsReviewCaseAction,
  getRightsReviewCaseDetail,
  listCommunityRightsReviewCases,
} from "../lib/rights/rights-review-service"
import type { CreateRightsReviewActionRequest } from "../lib/rights/rights-review-types"
import {
  getResolvedCommunityRouteContext,
  requireJsonBody,
} from "./communities-route-helpers"

export function registerCommunityRightsReviewRoutes(communities: Hono<AuthenticatedEnv>): void {
  communities.get("/:communityId/rights-review/cases", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await listCommunityRightsReviewCases({
      env: c.env,
      userId: actor.userId,
      communityId,
      communityRepository,
      status: c.req.query("status") ?? null,
      limit: c.req.query("limit") ?? null,
    })
    return c.json(result, 200)
  })

  communities.get("/:communityId/rights-review/cases/:rightsReviewCaseId", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await getRightsReviewCaseDetail({
      env: c.env,
      userId: actor.userId,
      communityId,
      communityRepository,
      rightsReviewCaseId: c.req.param("rightsReviewCaseId"),
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/rights-review/cases/:rightsReviewCaseId/actions", async (c) => {
    const { actor, communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CreateRightsReviewActionRequest>(c, "Invalid rights review action payload")
    const result = await applyRightsReviewCaseAction({
      env: c.env,
      userId: actor.userId,
      communityId,
      communityRepository,
      rightsReviewCaseId: c.req.param("rightsReviewCaseId"),
      body,
    })
    return c.json(result, 200)
  })
}
