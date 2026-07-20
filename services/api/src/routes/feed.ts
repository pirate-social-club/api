import { Hono } from "hono"
import type { Context } from "hono"
import { authenticateOptional, type OptionalAuthenticatedEnv } from "../lib/auth-middleware"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { getProfileRepository, getUserRepository } from "../lib/auth/repositories"
import { HOME_FEED_SERVER_TIMING, listHomeFeed } from "../lib/feed/home-feed-service"
import {
  buildMaterializedPublicHomeFeedTarget,
  readMaterializedPublicHomeFeed,
  refreshMaterializedPublicHomeFeed,
  storeMaterializedPublicHomeFeed,
} from "../lib/feed/materialized-public-feed"
import { getControlPlaneClient } from "../lib/runtime-deps"
import { resolveStudyTimezone } from "../lib/posts/post-study-service"
import { setPublicReadCacheHeaders } from "./cache-headers"
import type { Env, HomeFeedResponse } from "../types"

const feed = new Hono<OptionalAuthenticatedEnv>()

// Bounds the public feed's cold-miss live compute. Without a bound, a degraded
// shard fleet pushes the fan-out past the platform's ~100s response ceiling and
// the request 524s BEFORE the store step — so the cache can never repopulate
// from the request path and every subsequent miss repeats the failure (the
// absorbing state described in #673). Serving and STORING an empty degraded
// feed instead keeps the endpoint alive and hands recovery to the existing
// stale-refresh machinery, while the late compute below overwrites the empty
// entry with real data as soon as it lands.
const DEFAULT_PUBLIC_HOME_FEED_COMPUTE_BUDGET_MS = 25_000
const PUBLIC_HOME_FEED_DEGRADED = Symbol("public-home-feed-degraded")

// 0 is honored as an immediate-degrade kill switch (every cold miss serves the
// empty fallback without attempting the live compute's result in-request).
function resolvePublicHomeFeedComputeBudgetMs(env: Env): number {
  const raw = (env.PUBLIC_HOME_FEED_COMPUTE_BUDGET_MS ?? "").trim()
  if (!raw) return DEFAULT_PUBLIC_HOME_FEED_COMPUTE_BUDGET_MS
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : DEFAULT_PUBLIC_HOME_FEED_COMPUTE_BUDGET_MS
}

function emptyPublicHomeFeed(): HomeFeedResponse {
  return { items: [], top_communities: [], next_cursor: null }
}

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

  const computePromise = listHomeFeed({
    env: c.env,
    userId: null,
    locale: materializedTarget?.locale ?? c.req.query("locale") ?? null,
    sort: materializedTarget?.sort ?? c.req.query("sort") ?? null,
    timeRange: materializedTarget?.timeRange ?? c.req.query("time_range") ?? null,
    cursor: materializedTarget?.cursor ?? c.req.query("cursor") ?? null,
    communityRepository: getCommunityRepository(c.env),
    userRepository: null,
    profileRepository: getProfileRepository(c.env),
    waitUntil,
  })
  const budgetMs = resolvePublicHomeFeedComputeBudgetMs(c.env)
  let budgetTimer: ReturnType<typeof setTimeout> | undefined
  const raced = budgetMs === 0 ? PUBLIC_HOME_FEED_DEGRADED : await Promise.race([
    computePromise,
    new Promise<typeof PUBLIC_HOME_FEED_DEGRADED>((resolve) => {
      budgetTimer = setTimeout(() => resolve(PUBLIC_HOME_FEED_DEGRADED), budgetMs)
    }),
  ])
  if (budgetTimer !== undefined) clearTimeout(budgetTimer)
  if (raced === PUBLIC_HOME_FEED_DEGRADED) {
    console.error("[public-home-feed] live compute exceeded budget; serving degraded empty feed", JSON.stringify({
      budget_ms: budgetMs,
      cache_key: materializedTarget?.cacheKey ?? null,
    }))
    const degraded = emptyPublicHomeFeed()
    await storeMaterializedPublicHomeFeed({
      client: getControlPlaneClient(c.env),
      env: c.env,
      result: degraded,
      target: materializedTarget,
    })
    const lateStore = computePromise
      .then((late) => storeMaterializedPublicHomeFeed({
        client: getControlPlaneClient(c.env),
        env: c.env,
        result: late,
        target: materializedTarget,
      }))
      .catch((error: unknown) => {
        console.error("[public-home-feed] late compute after degraded response failed", error)
      })
    waitUntil?.(lateStore)
    // No public CDN cache headers: an empty degraded body must not outlive the
    // control-plane entry the stale-refresh path knows how to replace.
    c.header("x-pirate-materialized-feed", "degraded")
    return c.json(degraded, 200)
  }
  const result = raced
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
    studyTimezone: actor?.userId ? resolveStudyTimezone(c.req.raw.cf) : undefined,
    sort: c.req.query("sort") ?? null,
    timeRange: c.req.query("time_range") ?? null,
    cursor: c.req.query("cursor") ?? null,
    communityRepository: getCommunityRepository(c.env),
    userRepository: actor?.userId ? getUserRepository(c.env) : null,
    profileRepository: getProfileRepository(c.env),
    waitUntil: getWaitUntil(c),
  })
  if (!actor && !c.req.header("authorization")) {
    setPublicReadCacheHeaders(c, { vary: ["Authorization"] })
  }
  setHomeFeedServerTiming(c, result)
  return c.json(result, 200)
})

export default feed
