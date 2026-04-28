import { Hono } from "hono"
import type { AuthenticatedEnv } from "../lib/auth-middleware"
import { registerCommunityAdminRoutes } from "./communities-admin-routes"
import { registerCommunityContentRoutes } from "./communities-content-routes"
import { registerCommunityCreateRoutes } from "./communities-create-routes"
import { registerCommunityMembershipRoutes } from "./communities-membership-routes"
import { registerCommunityModerationRoutes } from "./communities-moderation-routes"
import { registerCommunitySettingsRoutes } from "./communities-settings-routes"

export function registerCommunityCoreRoutes(communities: Hono<AuthenticatedEnv>): void {
  registerCommunityAdminRoutes(communities)
  registerCommunityCreateRoutes(communities)
  registerCommunitySettingsRoutes(communities)
  registerCommunityMembershipRoutes(communities)
  registerCommunityContentRoutes(communities)
  registerCommunityModerationRoutes(communities)
}
