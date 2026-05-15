import { Hono } from "hono"
import type { Context } from "hono"
import { authenticateOptional, type OptionalAuthenticatedEnv } from "../lib/auth-middleware"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { getUserRepository } from "../lib/auth/repositories"
import { HOME_FEED_SERVER_TIMING, listHomeFeed } from "../lib/feed/home-feed-service"
import {
  buildMaterializedPublicHomeFeedTarget,
  readMaterializedPublicHomeFeed,
  refreshMaterializedPublicHomeFeed,
  storeMaterializedPublicHomeFeed,
} from "../lib/feed/materialized-public-feed"
import { getControlPlaneClient } from "../lib/runtime-deps"
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

function setHomeFeedServerTiming(c: Context, result: Awaited<ReturnType<typeof listHomeFeed>>): void {
  const value = result[HOME_FEED_SERVER_TIMING]
  if (value) {
    c.header("Server-Timing", value)
  }
}

feed.get("/home/public", async (c) => {
  const waitUntil = getWaitUntil(c)
  const url = new URL(c.req.url)
  const materializedTarget = buildMaterializedPublicHomeFeedTarget({
    cursor: c.req.query("cursor") ?? null,
    locale: c.req.query("locale") ?? null,
    searchParams: url.searchParams,
    sort: c.req.query("sort") ?? null,
    timeRange: c.req.query("time_range") ?? null,
  })
  const materialized = await readMaterializedPublicHomeFeed({
    client: getControlPlaneClient(c.env),
    target: materializedTarget,
  })
  if (materialized.result) {
    if (materialized.state === "stale") {
      waitUntil?.(refreshMaterializedPublicHomeFeed({
        env: c.env,
        target: materializedTarget,
      }))
    }
    setPublicReadCacheHeaders(c)
    setHomeFeedServerTiming(c, materialized.result)
    c.header("x-pirate-materialized-feed", materialized.state)
    return c.json(materialized.result, 200)
  }

  const result = await listHomeFeed({
    env: c.env,
    userId: null,
    locale: materializedTarget?.locale ?? c.req.query("locale") ?? null,
    sort: materializedTarget?.sort ?? c.req.query("sort") ?? null,
    timeRange: materializedTarget?.timeRange ?? c.req.query("time_range") ?? null,
    cursor: materializedTarget?.cursor ?? c.req.query("cursor") ?? null,
    communityRepository: getCommunityRepository(c.env),
    userRepository: null,
    waitUntil,
  })
  const store = storeMaterializedPublicHomeFeed({
    client: getControlPlaneClient(c.env),
    env: c.env,
    result,
    target: materializedTarget,
  })
  await store
  setPublicReadCacheHeaders(c)
  setHomeFeedServerTiming(c, result)
  c.header("x-pirate-materialized-feed", materialized.state)
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
  setHomeFeedServerTiming(c, result)
  return c.json(result, 200)
})

export default feed
