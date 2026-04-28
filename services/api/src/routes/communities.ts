import { Hono } from "hono"
import {
  authenticate,
  authenticateAdminToken,
  authenticateAgentDelegatedToken,
  authenticateUserToken,
  requireBearerToken,
  type AuthenticatedEnv,
} from "../lib/auth-middleware"
import { registerCommunityAdminRoutes } from "./communities-admin-routes"
import { registerCommunityCommerceRoutes } from "./communities-commerce"
import { registerCommunityContentRoutes } from "./communities-content-routes"
import { registerCommunityCreateRoutes } from "./communities-create-routes"
import { registerCommunityMembershipRoutes } from "./communities-membership-routes"
import { registerCommunityModerationRoutes } from "./communities-moderation-routes"
import { registerCommunitySettingsRoutes } from "./communities-settings-routes"
import { registerCommunitySongArtifactRoutes } from "./communities-song-artifacts"

const communities = new Hono<AuthenticatedEnv>()
const communityAuthPolicy = new Hono()

const publicAccess = () => new Response(null, { status: 204 })
const agentDelegatedAccess = () => new Response(null, { status: 204 })

communityAuthPolicy.get("/:communityId/song-artifact-uploads/:uploadId/content", publicAccess)
communityAuthPolicy.post("/:communityId/posts", agentDelegatedAccess)
communityAuthPolicy.post("/:communityId/posts/:postId/comments", agentDelegatedAccess)

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

  const adminActor = authenticateAdminToken({
    env: c.env,
    token: c.req.header("x-admin-token"),
    asUserId: c.req.header("x-admin-as-user-id"),
  })
  if (adminActor) {
    c.set("actor", adminActor)
    await next()
    return
  }

  if (authPolicy === "agent-delegated") {
    const token = requireBearerToken(c.req.header("authorization"))
    try {
      c.set("actor", await authenticateUserToken({ env: c.env, token }))
    } catch {
      c.set("actor", await authenticateAgentDelegatedToken({ env: c.env, token }))
    }
    await next()
    return
  }

  return authenticate(c, next)
})

registerCommunityAdminRoutes(communities)
registerCommunityCreateRoutes(communities)
registerCommunitySettingsRoutes(communities)
registerCommunityMembershipRoutes(communities)
registerCommunityContentRoutes(communities)
registerCommunityModerationRoutes(communities)
registerCommunityCommerceRoutes(communities)
registerCommunitySongArtifactRoutes(communities)

export default communities
