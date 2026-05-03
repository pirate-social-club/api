import { Hono } from "hono"
import { authenticateOptional, type OptionalAuthenticatedEnv } from "../lib/auth-middleware"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { getUserRepository } from "../lib/auth/repositories"
import { listHomeFeed } from "../lib/feed/home-feed-service"

const feed = new Hono<OptionalAuthenticatedEnv>()

feed.use("*", authenticateOptional)

feed.get("/home", async (c) => {
  const actor = c.get("actor")
  const result = await listHomeFeed({
    env: c.env,
    userId: actor?.userId ?? null,
    locale: c.req.query("locale") ?? null,
    sort: c.req.query("sort") ?? null,
    timeRange: c.req.query("time_range") ?? null,
    cursor: c.req.query("cursor") ?? null,
    communityRepository: getCommunityRepository(c.env),
    userRepository: actor?.userId ? getUserRepository(c.env) : null,
  })
  return c.json(result, 200)
})

export default feed
