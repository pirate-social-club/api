import { Hono } from "hono"
import {
  authenticate,
  authenticateAdminOrUser,
  authenticateAdminToken,
  authenticateAgentDelegatedToken,
  authenticateUserToken,
  requireBearerToken,
  type AuthenticatedEnv,
} from "../lib/auth-middleware"
import { registerCommunityCommerceRoutes } from "./communities-commerce"
import { registerCommunityCoreRoutes } from "./communities-core"
import { registerCommunitySongArtifactRoutes } from "./communities-song-artifacts"

const communities = new Hono<AuthenticatedEnv>()

communities.use("*", async (c, next) => {
  const pathname = new URL(c.req.url).pathname
  if (
    c.req.method === "GET"
    && /^\/communities\/[^/]+\/song-artifact-uploads\/[^/]+\/content$/.test(pathname)
  ) {
    await next()
    return
  }

  const allowsAgentDelegation = c.req.method === "POST" && (
    /^\/communities\/[^/]+\/posts$/.test(pathname)
    || /^\/communities\/[^/]+\/posts\/[^/]+\/comments$/.test(pathname)
  )
  if (allowsAgentDelegation) {
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

    const token = requireBearerToken(c.req.header("authorization"))
    try {
      c.set("actor", await authenticateUserToken({ env: c.env, token }))
    } catch {
      c.set("actor", await authenticateAgentDelegatedToken({ env: c.env, token }))
    }
    await next()
    return
  }

  return authenticateAdminOrUser(c, next)
})

registerCommunityCoreRoutes(communities)
registerCommunityCommerceRoutes(communities)
registerCommunitySongArtifactRoutes(communities)

export default communities
