import { Hono } from "hono"
import { authenticate, type AuthenticatedEnv } from "../lib/auth-middleware"
import { registerCommunityCommerceRoutes } from "./communities-commerce"
import { registerCommunityCoreRoutes } from "./communities-core"
import { registerCommunitySongArtifactRoutes } from "./communities-song-artifacts"

const communities = new Hono<AuthenticatedEnv>()

communities.use("*", async (c, next) => {
  if (
    c.req.method === "GET"
    && /^\/communities\/[^/]+\/song-artifact-uploads\/[^/]+\/content$/.test(new URL(c.req.url).pathname)
  ) {
    await next()
    return
  }
  return authenticate(c, next)
})

registerCommunityCoreRoutes(communities)
registerCommunityCommerceRoutes(communities)
registerCommunitySongArtifactRoutes(communities)

export default communities
