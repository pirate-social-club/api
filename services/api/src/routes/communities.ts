import { Hono } from "hono"
import {
  authenticateAdminUserOrAgentDelegated,
  type AuthenticatedEnv,
} from "../lib/auth-middleware"
import { registerCommunityAdminRoutes } from "./communities-admin-routes"
import { registerCommunityBookingsRoutes } from "./communities-bookings"
import { registerCommunityAssistantRoutes } from "./communities-assistant-routes"
import { registerCommunityCommerceRoutes } from "./communities-commerce"
import { registerCommunityContentRoutes } from "./communities-content-routes"
import { registerCommunityCreateRoutes } from "./communities-create-routes"
import { registerCommunityHandleRoutes } from "./communities-handles-routes"
import { registerCommunityLiveRoomRoutes } from "./communities-live-rooms"
import { registerCommunityKaraokeSessionRoutes } from "./communities-karaoke-session-routes"
import { registerCommunityMembershipRoutes } from "./communities-membership-routes"
import { registerCommunityModerationRoutes } from "./communities-moderation-routes"
import { registerCommunityRoleRoutes } from "./communities-role-routes"
import { registerCommunitySettingsRoutes } from "./communities-settings-routes"
import { registerCommunitySongArtifactRoutes } from "./communities-song-artifacts"
import { registerCommunityStudyRoutes } from "./communities-study-routes"
import { registerCommunityTelegramRoutes } from "./communities-telegram-routes"

const communities = new Hono<AuthenticatedEnv>()
const communityAuthPolicy = new Hono()

const publicAccess = () => new Response(null, { status: 204 })
const agentDelegatedAccess = () => new Response(null, { status: 204 })

communityAuthPolicy.get("/:communityId/song-artifact-uploads/:uploadId/content", publicAccess)
communityAuthPolicy.on("HEAD", "/:communityId/song-artifact-uploads/:uploadId/content", publicAccess)
communityAuthPolicy.get("/:communityId/telegram-bot-username", publicAccess)
communityAuthPolicy.get("/:communityId/posts/:postId/karaoke", publicAccess)
communityAuthPolicy.post("/:communityId/posts", agentDelegatedAccess)
communityAuthPolicy.post("/:communityId/posts/:postId/comments", agentDelegatedAccess)
communityAuthPolicy.post("/:communityId/bookings/:bookingId/settlement-review/resolve", publicAccess)

function communityPath(url: string): string {
  const pathname = new URL(url).pathname
  const mountPath = "/communities"
  if (pathname === mountPath) {
    return "/"
  }
  if (pathname.startsWith(`${mountPath}/`)) {
    return pathname.slice(mountPath.length)
  }
  return pathname
}

function authPolicyFor(method: string, path: string): "public" | "agent-delegated" | null {
  const [matches] = communityAuthPolicy.router.match(method, path)
  for (const [[handler]] of matches) {
    if (handler === publicAccess) {
      return "public"
    }
    if (handler === agentDelegatedAccess) {
      return "agent-delegated"
    }
  }
  return null
}

communities.use("*", async (c, next) => {
  const authPolicy = authPolicyFor(c.req.method, communityPath(c.req.url))
  if (authPolicy === "public") {
    await next()
    return
  }

  c.set("actor", await authenticateAdminUserOrAgentDelegated({
    allowAgentDelegated: authPolicy === "agent-delegated",
    authorization: c.req.header("authorization"),
    env: c.env,
    xAdminAsUserId: c.req.header("x-admin-as-user-id"),
    xAdminToken: c.req.header("x-admin-token"),
  }))
  await next()
})

registerCommunityAdminRoutes(communities)
registerCommunityCreateRoutes(communities)
registerCommunitySettingsRoutes(communities)
registerCommunityAssistantRoutes(communities)
registerCommunityMembershipRoutes(communities)
registerCommunityHandleRoutes(communities)
registerCommunityContentRoutes(communities)
registerCommunityModerationRoutes(communities)
registerCommunityRoleRoutes(communities)
registerCommunityCommerceRoutes(communities)
registerCommunityBookingsRoutes(communities)
registerCommunitySongArtifactRoutes(communities)
registerCommunityLiveRoomRoutes(communities)
registerCommunityKaraokeSessionRoutes(communities)
registerCommunityStudyRoutes(communities)
registerCommunityTelegramRoutes(communities)

export default communities
