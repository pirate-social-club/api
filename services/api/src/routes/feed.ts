import { Hono } from "hono"
import { authenticate, type AuthenticatedEnv } from "../lib/auth-middleware"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { listHomeFeed } from "../lib/feed/home-feed-service"

const feed = new Hono<AuthenticatedEnv>()

feed.use("*", authenticate)

feed.get("/home", async (c) => {
  const actor = c.get("actor")
  const result = await listHomeFeed({
    env: c.env,
    userId: actor.userId,
    locale: c.req.query("locale") ?? null,
    sort: c.req.query("sort") ?? null,
    cursor: c.req.query("cursor") ?? null,
    communityRepository: getCommunityRepository(c.env),
  })
  return c.json(result, 200)
})

export default feed
