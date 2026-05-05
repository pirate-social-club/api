import { Hono } from "hono"
import type { Context } from "hono"
import { authenticateOptional, type OptionalAuthenticatedEnv } from "../lib/auth-middleware"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { getUserRepository } from "../lib/auth/repositories"
import { listHomeFeed } from "../lib/feed/home-feed-service"
import { setPublicReadCacheHeaders } from "./cache-headers"

const feed = new Hono<OptionalAuthenticatedEnv>()

function getWaitUntil(c: Context): ((promise: Promise<void>) => void) | undefined {
  let waitUntil: ((promise: Promise<void>) => void) | undefined
  try {
    const executionCtx = c.executionCtx
    waitUntil = (promise) => executionCtx.waitUntil(promise)
  } catch {
    waitUntil = undefined
  }
  return waitUntil
}

feed.get("/home/public", async (c) => {
  const result = await listHomeFeed({
    env: c.env,
    userId: null,
    locale: c.req.query("locale") ?? null,
    sort: c.req.query("sort") ?? null,
    timeRange: c.req.query("time_range") ?? null,
    cursor: c.req.query("cursor") ?? null,
    communityRepository: getCommunityRepository(c.env),
    userRepository: null,
    waitUntil: getWaitUntil(c),
  })
  setPublicReadCacheHeaders(c)
  return c.json(result, 200)
})

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
    waitUntil: getWaitUntil(c),
  })
  if (!actor && !c.req.header("authorization")) {
    setPublicReadCacheHeaders(c, { vary: ["Authorization"] })
  }
  return c.json(result, 200)
})

export default feed
