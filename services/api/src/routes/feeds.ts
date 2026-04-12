import { Hono } from "hono"
import { getControlPlaneCommunityRepository } from "../lib/communities/control-plane-community-repository"
import { getHomeFeed, getYourCommunitiesFeed } from "../lib/feeds/feed-service"
import { requireBearerToken } from "../lib/helpers"
import { handleRoute } from "./route-helpers"
import type { Env } from "../types"

const feeds = new Hono<{ Bindings: Env }>()

feeds.get("/home", handleRoute(async (c) => {
  const result = await getHomeFeed({
    env: c.env,
    authorizationHeader: c.req.header("authorization"),
    locale: c.req.query("locale") ?? null,
    limit: c.req.query("limit") ?? null,
    cursor: c.req.query("cursor") ?? null,
    communityRepository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

feeds.get("/your-communities", handleRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const result = await getYourCommunitiesFeed({
    env: c.env,
    bearerToken: token,
    locale: c.req.query("locale") ?? null,
    limit: c.req.query("limit") ?? null,
    cursor: c.req.query("cursor") ?? null,
    communityRepository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

export default feeds
