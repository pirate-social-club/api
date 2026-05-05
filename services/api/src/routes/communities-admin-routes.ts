import { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import { authError } from "../lib/errors"
import { migrateProvisionedCommunityDatabase } from "../lib/communities/provisioning/admin-migration-service"
import {
  getCommunityCreationRouteContext,
  getResolvedCommunityRouteContext,
} from "./communities-route-helpers"

function requireAdmin(c: Parameters<typeof getCommunityCreationRouteContext>[0]) {
  const { actor } = getCommunityCreationRouteContext(c)
  if (actor.authType !== "admin") {
    throw authError("Admin authentication required")
  }
  return actor
}

export function registerCommunityAdminRoutes(communities: Hono<AuthenticatedEnv>): void {
  communities.get("/admin/health", async (c) => {
    const actor = requireAdmin(c)
    return c.json({
      ok: true,
      mode: "admin",
      admin_actor_id: actor.adminOverride.adminActorId,
      acting_user_id: actor.userId,
      scope: actor.adminOverride.scope,
    }, 200)
  })

  communities.post("/:communityId/admin/database-migrations", async (c) => {
    requireAdmin(c)
    const { communityId, communityRepository } = await getResolvedCommunityRouteContext(c)
    const result = await migrateProvisionedCommunityDatabase({
      env: c.env,
      communityId,
      communityRepository,
    })
    return c.json(result, 200)
  })
}
