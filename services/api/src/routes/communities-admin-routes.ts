import type { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import { authError } from "../lib/errors"

export function registerCommunityAdminRoutes(communities: Hono<AuthenticatedEnv>): void {
  communities.get("/admin/health", async (c) => {
    const actor = c.get("actor")
    if (actor.authType !== "admin") {
      throw authError("Admin authentication required")
    }
    return c.json({
      ok: true,
      mode: "admin",
      admin_actor_id: actor.adminOverride.adminActorId,
      acting_user_id: actor.userId,
      scope: actor.adminOverride.scope,
    }, 200)
  })
}
