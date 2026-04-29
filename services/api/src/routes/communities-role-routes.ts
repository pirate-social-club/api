import { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import {
  grantCommunityRole,
  revokeCommunityRole,
  type CommunityRoleMutationBody,
} from "../lib/communities/community-role-service"
import {
  getResolvedCommunityRouteContext,
  requireJsonBody,
} from "./communities-route-helpers"

export function registerCommunityRoleRoutes(communities: Hono<AuthenticatedEnv>): void {
  communities.post("/:communityId/roles/grant", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CommunityRoleMutationBody>(c, "Invalid community role payload")
    const result = await grantCommunityRole({
      env: c.env,
      actor,
      communityId,
      body,
      communityRepository,
      userRepository,
    })
    return c.json(result, 200)
  })

  communities.post("/:communityId/roles/revoke", async (c) => {
    const { actor, communityId, communityRepository, userRepository } = await getResolvedCommunityRouteContext(c)
    const body = await requireJsonBody<CommunityRoleMutationBody>(c, "Invalid community role payload")
    const result = await revokeCommunityRole({
      env: c.env,
      actor,
      communityId,
      body,
      communityRepository,
      userRepository,
    })
    return c.json(result, 200)
  })
}
