import { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import { authError } from "../lib/errors"
import { getCommunityCreationRouteContext } from "./communities-route-helpers"

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
}
