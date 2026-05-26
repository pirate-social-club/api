import { Hono } from "hono"
import { cors } from "hono/cors"
import { captureException, withSentry } from "@sentry/cloudflare"
import agents from "./routes/agents"
import analytics from "./routes/analytics"
import auth from "./routes/auth"
import botUsers from "./routes/bot-users"
import debugPipeline from "./routes/debug-pipeline"
import communityMedia from "./routes/community-media"
import comments from "./routes/comments"
import communities from "./routes/communities"
import discovery from "./routes/discovery"
import feed from "./routes/feed"
import jobs from "./routes/jobs"
import mcp from "./routes/mcp"
import notifications from "./routes/notifications"
import oauth from "./routes/oauth"
import royalties from "./routes/royalties"
import onboarding from "./routes/onboarding"
import posts from "./routes/posts"
import publicComments from "./routes/public-comments"
import publicAgents from "./routes/public-agents"
import publicCommunities from "./routes/public-communities"
import publicNames from "./routes/public-names"
import publicNamespaces from "./routes/public-namespaces"
import publicPosts from "./routes/public-posts"
import publicProfiles from "./routes/public-profiles"
import profileMedia from "./routes/profile-media"
import profiles from "./routes/profiles"
import telegram from "./routes/telegram"
import users from "./routes/users"
import verification from "./routes/verification"
import walletIdentities from "./routes/wallet-identities"
import {
  buildPublicReadCacheKey,
  isPublicReadCacheRequest,
  isPublicReadCacheResponse,
  PUBLIC_READ_CACHE_CONTROL,
  PUBLIC_READ_CACHE_FRESH_SECONDS,
  PUBLIC_READ_CACHE_STALE_SECONDS,
  PUBLIC_READ_CDN_CACHE_CONTROL,
} from "./routes/cache-headers"
import { flushAnalyticsOutbox, isAnalyticsEnabled, syncCommunityHealthCounts } from "./lib/analytics"
import { getCommunityRepository } from "./lib/communities/db-community-repository"
import { reconcileStaleCommunityPurchaseSettlements } from "./lib/communities/commerce/settlement-service"
import { processAvailableCommunityJobs } from "./lib/communities/jobs/runner"
import { reconcileCommunityMembershipAndFollowProjections } from "./lib/communities/membership/projection-service"
import { getCommunityProvisionOperatorVersion } from "./lib/communities/provisioning/operator-client"
import { HttpError, errorResponse } from "./lib/errors"
import { refreshScheduledMaterializedPublicHomeFeeds } from "./lib/feed/materialized-public-feed"
import { reconcileRoyaltyClaimEvents } from "./lib/royalties/royalty-claim-history"
import { getControlPlaneClient, withRequestControlPlaneClients } from "./lib/runtime-deps"
import { makeSentryOptions, captureScheduledError } from "./lib/sentry"
import { LiveRoomRuntimeDO } from "./lib/communities/live-rooms/runtime"
import type { Env } from "./env"

export { LiveRoomRuntimeDO }

declare const __PIRATE_BUILD_GIT_REF__: string | undefined
declare const __PIRATE_BUILD_GIT_SHA__: string | undefined
declare const __PIRATE_BUILD_TIMESTAMP__: string | undefined

const app = new Hono<{ Bindings: Env }>()
const PUBLIC_READ_WORKER_CACHE_CREATED_HEADER = "x-pirate-cache-created-at"
const PUBLIC_READ_WORKER_CACHE_TTL_HEADER = "x-pirate-cache-ttl"
const publicReadCacheFillRequests = new Map<string, Promise<PublicReadCacheFillResult>>()
const publicReadCacheRefreshRequests = new Map<string, Promise<void>>()

export function resetPublicReadCacheDedupeForTests(): void {
  publicReadCacheFillRequests.clear()
  publicReadCacheRefreshRequests.clear()
}

type PublicReadCacheFillResult = {
  body: ArrayBuffer
  cacheable: boolean
  headers: [string, string][]
  status: number
  statusText: string
}

type BuildVersionMetadata = {
  git_ref: string | null
  git_sha: string | null
  build_timestamp: string | null
}

const COMPILED_BUILD_VERSION_METADATA: BuildVersionMetadata = {
  git_ref: typeof __PIRATE_BUILD_GIT_REF__ === "string" ? __PIRATE_BUILD_GIT_REF__ : null,
  git_sha: typeof __PIRATE_BUILD_GIT_SHA__ === "string" ? __PIRATE_BUILD_GIT_SHA__ : null,
  build_timestamp: typeof __PIRATE_BUILD_TIMESTAMP__ === "string" ? __PIRATE_BUILD_TIMESTAMP__ : null,
}

export function buildVersionMetadata(
  env: Pick<Env, "BUILD_GIT_REF" | "BUILD_GIT_SHA" | "BUILD_TIMESTAMP">,
  compiled: BuildVersionMetadata = COMPILED_BUILD_VERSION_METADATA,
): BuildVersionMetadata {
  return {
    git_ref: env.BUILD_GIT_REF ?? compiled.git_ref,
    git_sha: env.BUILD_GIT_SHA ?? compiled.git_sha,
    build_timestamp: env.BUILD_TIMESTAMP ?? compiled.build_timestamp,
  }
}

async function buildVersionPayload(env: Env) {
  const buildVersion = buildVersionMetadata(env)
  return {
    service: "api",
    environment: env.ENVIRONMENT ?? null,
    git_sha: buildVersion.git_sha,
    git_ref: buildVersion.git_ref,
    build_timestamp: buildVersion.build_timestamp,
    api_origin: env.PIRATE_API_PUBLIC_ORIGIN ?? null,
    operator: await getCommunityProvisionOperatorVersion(env),
  }
}

function configuredCorsOrigin(origin: string, c: { env: Env }): string | null {
  if (isTrustedHnsWebOrigin(origin)) {
    return origin
  }

  const raw = c.env?.CORS_ALLOWED_ORIGINS?.trim()
  if (!raw) {
    return null
  }

  const allowedOrigins = raw.split(",").map((allowedOrigin) => allowedOrigin.trim()).filter(Boolean)
  if (allowedOrigins.includes("*")) {
    return "*"
  }
  return allowedOrigins.includes(origin) ? origin : null
}

function isTrustedHnsWebOrigin(origin: string): boolean {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }

  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    return false
  }

  const hostname = url.hostname.toLowerCase()
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u.test(hostname)) {
    return false
  }

  if (!hostname.includes(".")) {
    return true
  }

  return hostname.endsWith(".pirate") || hostname.endsWith(".clawitzer")
}

app.use(
  "/*",
  cors({
    origin: configuredCorsOrigin,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-Admin-As-User-Id",
      "X-Admin-Token",
      "X-Agent-Connection-Token",
      "X-Pirate-Altcha",
      "X-Pirate-Anonymous-Id",
      "X-Pirate-Session-Id",
    ],
  }),
)

app.use("*", async (_c, next) => {
  await withRequestControlPlaneClients(next)
})

app.get("/health", (c) => c.json({ ok: true }))
app.get("/__version", async (c) => c.json(await buildVersionPayload(c.env), 200, {
  "cache-control": "no-store",
}))
app.route("/", discovery)
app.route("/", agents)
app.route("/analytics", analytics)
app.route("/auth", auth)
app.route("/admin/bot-users", botUsers)
app.route("/admin/debug", debugPipeline)
app.route("/community-media", communityMedia)
app.route("/comments", comments)
app.route("/communities", communities)
app.route("/feed", feed)
app.route("/jobs", jobs)
app.route("/mcp", mcp)
app.route("/notifications", notifications)
app.route("/oauth", oauth)
app.route("/royalties", royalties)
app.route("/posts", posts)
app.route("/public-comments", publicComments)
app.route("/public-agents", publicAgents)
app.route("/public-communities", publicCommunities)
app.route("/public-names", publicNames)
app.route("/public-namespaces", publicNamespaces)
app.route("/public-posts", publicPosts)
app.route("/public-profiles", publicProfiles)
app.route("/profile-media", profileMedia)
app.route("/users", users)
app.route("/onboarding", onboarding)
app.route("/profiles", profiles)
app.route("/telegram", telegram)
app.route("/wallet-identities", walletIdentities)
app.route("/", verification)

app.get("/__debug/sentry-error", (c) => {
  if (c.env.ENVIRONMENT === "production") {
    return c.json({ error: "not_found" }, 404)
  }
  throw new Error("Sentry smoke test: intentional 500")
})

app.notFound((c) => c.json({ code: "not_found", message: "Not found" }, 404))

app.onError((error, c) => {
  if (!(error instanceof HttpError) || error.status >= 500) {
    console.error("[api-worker]", error)
    if (c.env.SENTRY_DSN) {
      const details = error instanceof HttpError ? error.details : null
      const causeDetails = details?.cause_details && typeof details.cause_details === "object"
        ? details.cause_details as Record<string, unknown>
        : null
      captureException(error, {
        tags: {
          route: c.req.path,
          method: c.req.method,
          status: error instanceof HttpError ? String(error.status) : "500",
          ...(typeof details?.community_id === "string" ? { community_id: details.community_id } : {}),
          ...(typeof details?.job_id === "string" ? { job_id: details.job_id } : {}),
          ...(typeof causeDetails?.operator_error_code === "string" ? { operator_error_code: causeDetails.operator_error_code } : {}),
          ...(typeof causeDetails?.operator_request_id === "string" ? { operator_request_id: causeDetails.operator_request_id } : {}),
          ...(typeof causeDetails?.operator_step === "string" ? { operator_step: causeDetails.operator_step } : {}),
        },
        extra: {
          ...(details ? { details } : {}),
          ...(typeof causeDetails?.operator_message === "string" ? { operator_message: causeDetails.operator_message } : {}),
        },
      })
    }
  }
  const response = errorResponse(error)
  return new Response(JSON.stringify(response.body), {
    status: response.status,
    headers: {
      "content-type": "application/json",
    },
  })
})

async function fetchWithPublicReadCache(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!isPublicReadCacheRequest(req) || typeof caches === "undefined") {
    return withPublicReadCacheHeaders(await app.fetch(req, env, ctx), {
      stored: null,
      status: "bypass",
    })
  }

  const cache = await caches.open("public-read")
  const cacheKey = buildPublicReadCacheKey(req)
  const cacheKeyId = cacheKey.url
  const cachedResponse = await cache.match(cacheKey)
  if (cachedResponse) {
    const freshness = getPublicReadCachedResponseFreshness(cachedResponse)
    if (freshness === "stale") {
      ctx.waitUntil(refreshPublicReadCache(req, env, ctx, cache, cacheKey, cacheKeyId))
      return withPublicReadCacheHeaders(cachedResponse, {
        restorePublicCacheHeaders: true,
        stored: null,
        status: "stale",
      })
    }
    return withPublicReadCacheHeaders(cachedResponse, {
      restorePublicCacheHeaders: true,
      stored: null,
      status: "hit",
    })
  }

  const existingFill = publicReadCacheFillRequests.get(cacheKeyId)
  const fill = existingFill ?? startPublicReadCacheFill(req, env, ctx, cache, cacheKey, cacheKeyId)
  const result = await fill
  return withPublicReadCacheHeaders(buildPublicReadCacheFillResponse(result), {
    deduped: Boolean(existingFill),
    stored: result.cacheable,
    status: "miss",
  })
}

function startPublicReadCacheFill(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  cache: Cache,
  cacheKey: Request,
  cacheKeyId: string,
): Promise<PublicReadCacheFillResult> {
  const fill = fillPublicReadCache(req, env, ctx, cache, cacheKey).finally(() => {
    publicReadCacheFillRequests.delete(cacheKeyId)
  })
  publicReadCacheFillRequests.set(cacheKeyId, fill)
  return fill
}

async function fillPublicReadCache(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  cache: Cache,
  cacheKey: Request,
): Promise<PublicReadCacheFillResult> {
  const response = await app.fetch(req, env, ctx)
  const cacheable = isPublicReadCacheResponse(response)
  const body = await response.arrayBuffer()
  const result: PublicReadCacheFillResult = {
    body,
    cacheable,
    headers: [...response.headers.entries()],
    status: response.status,
    statusText: response.statusText,
  }
  if (cacheable) {
    ctx.waitUntil(cache.put(cacheKey, buildPublicReadWorkerCacheResponse(buildPublicReadCacheFillResponse(result))))
  }
  return result
}

function buildPublicReadCacheFillResponse(result: PublicReadCacheFillResult): Response {
  return new Response(result.body.slice(0), {
    headers: result.headers,
    status: result.status,
    statusText: result.statusText,
  })
}

function buildPublicReadWorkerCacheResponse(response: Response): Response {
  const stored = new Response(response.body, response)
  const maxAgeSeconds = PUBLIC_READ_CACHE_FRESH_SECONDS + PUBLIC_READ_CACHE_STALE_SECONDS
  const workerCacheControl = `public, max-age=${maxAgeSeconds}`
  stored.headers.set("Cache-Control", workerCacheControl)
  stored.headers.set("CDN-Cache-Control", workerCacheControl)
  stored.headers.set(PUBLIC_READ_WORKER_CACHE_CREATED_HEADER, String(Date.now()))
  stored.headers.set(
    PUBLIC_READ_WORKER_CACHE_TTL_HEADER,
    `${PUBLIC_READ_CACHE_FRESH_SECONDS},${PUBLIC_READ_CACHE_STALE_SECONDS}`,
  )
  return stored
}

function getPublicReadCachedResponseFreshness(response: Response): "fresh" | "stale" {
  const created = Number(response.headers.get(PUBLIC_READ_WORKER_CACHE_CREATED_HEADER))
  if (!Number.isFinite(created) || created <= 0) {
    return "fresh"
  }

  const ageMs = Date.now() - created
  return ageMs > PUBLIC_READ_CACHE_FRESH_SECONDS * 1000 ? "stale" : "fresh"
}

async function refreshPublicReadCache(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  cache: Cache,
  cacheKey: Request,
  cacheKeyId: string,
): Promise<void> {
  const existingRefresh = publicReadCacheRefreshRequests.get(cacheKeyId)
  if (existingRefresh) {
    return existingRefresh
  }

  const refresh = refreshPublicReadCacheOnce(req, env, ctx, cache, cacheKey).finally(() => {
    publicReadCacheRefreshRequests.delete(cacheKeyId)
  })
  publicReadCacheRefreshRequests.set(cacheKeyId, refresh)
  return refresh
}

async function refreshPublicReadCacheOnce(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  cache: Cache,
  cacheKey: Request,
): Promise<void> {
  try {
    const response = await app.fetch(req, env, ctx)
    if (isPublicReadCacheResponse(response)) {
      await cache.put(cacheKey, buildPublicReadWorkerCacheResponse(response.clone()))
    }
  } catch (error) {
    console.error("[public-read-cache] stale refresh failed", error)
  }
}

function withPublicReadCacheHeaders(response: Response, input: {
  deduped?: boolean
  restorePublicCacheHeaders?: boolean
  status: "bypass" | "hit" | "miss" | "stale"
  stored: boolean | null
}): Response {
  const annotated = new Response(response.body, response)
  annotated.headers.delete(PUBLIC_READ_WORKER_CACHE_CREATED_HEADER)
  annotated.headers.delete(PUBLIC_READ_WORKER_CACHE_TTL_HEADER)
  if (input.restorePublicCacheHeaders) {
    annotated.headers.set("Cache-Control", PUBLIC_READ_CACHE_CONTROL)
    annotated.headers.set("CDN-Cache-Control", PUBLIC_READ_CDN_CACHE_CONTROL)
  }
  annotated.headers.set("x-pirate-cache", input.status)
  if (input.stored !== null) {
    annotated.headers.set("x-pirate-cache-stored", input.stored ? "1" : "0")
  }
  if (input.deduped) {
    annotated.headers.set("x-pirate-cache-deduped", "1")
  }
  return annotated
}

async function flushScheduledAnalytics(env: Env): Promise<void> {
  if (!isAnalyticsEnabled(env)) {
    return
  }

  const db = getControlPlaneClient(env)
  try {
    await flushAnalyticsOutbox(env, db)
  } catch (error) {
    console.error("[analytics] scheduled flush failed", error)
    captureScheduledError(env, error, "analytics_flush")
  } finally {
    db.close?.()
  }
}

async function syncScheduledCommunityHealthCounts(env: Env): Promise<void> {
  if (!isAnalyticsEnabled(env)) {
    return
  }

  if (!env.TINYBIRD_READ_TOKEN) {
    const error = new Error("TINYBIRD_READ_TOKEN is required to sync community health counts")
    console.error("[analytics] scheduled community health sync failed", error)
    captureScheduledError(env, error, "community_health_sync")
    return
  }

  const db = getControlPlaneClient(env)
  try {
    const summary = await syncCommunityHealthCounts(env, db)
    if (summary.synced_communities > 0) {
      console.info("[analytics] synced community health counts", JSON.stringify(summary))
    }
  } catch (error) {
    console.error("[analytics] scheduled community health sync failed", error)
    captureScheduledError(env, error, "community_health_sync")
  } finally {
    db.close?.()
  }
}

async function processScheduledCommunityJobs(env: Env): Promise<void> {
  const communityRepository = getCommunityRepository(env)
  try {
    const summary = await processAvailableCommunityJobs({
      env,
      communityRepository,
      maxCommunities: 100,
      maxJobsPerCommunity: 25,
    })
    if (summary.processed_jobs > 0) {
      console.info("[community-jobs] scheduled processed", JSON.stringify({
        processed_jobs: summary.processed_jobs,
        communities: summary.communities.map((community) => ({
          community_id: community.community_id,
          processed_jobs: community.processed_jobs,
        })),
      }))
    }
  } catch (error) {
    console.error("[community-jobs] scheduled processing failed", error)
    captureScheduledError(env, error, "community_jobs")
  } finally {
    await communityRepository.close?.()
  }
}

async function reconcileScheduledRoyaltyClaims(env: Env): Promise<void> {
  try {
    const summary = await reconcileRoyaltyClaimEvents({ env, limit: 25 })
    if (summary.checked > 0) {
      console.info("[royalties] reconciled claim txs", JSON.stringify(summary))
    }
  } catch (error) {
    console.error("[royalties] claim reconciliation failed", error)
    captureScheduledError(env, error, "royalty_reconciliation")
  }
}

async function reconcileScheduledPurchaseSettlements(env: Env): Promise<void> {
  const communityRepository = getCommunityRepository(env)
  try {
    const summary = await reconcileStaleCommunityPurchaseSettlements({
      env,
      communityRepository,
      maxCommunities: 100,
      maxAttemptsPerCommunity: 10,
    })
    if (summary.checked > 0) {
      console.info("[purchase-settlements] reconciled stale attempts", JSON.stringify(summary))
    }
  } catch (error) {
    console.error("[purchase-settlements] reconciliation failed", error)
    captureScheduledError(env, error, "purchase_settlement_reconciliation")
  } finally {
    await communityRepository.close?.()
  }
}

async function reconcileScheduledCommunityMembershipProjections(env: Env): Promise<void> {
  const communityRepository = getCommunityRepository(env)
  try {
    const summary = await reconcileCommunityMembershipAndFollowProjections({
      env,
      communityRepository,
      maxCommunities: 100,
      maxRowsPerCommunity: 500,
    })
    if (
      summary.synced_membership_projections > 0
      || summary.synced_follow_projections > 0
      || summary.corrected_follower_counts > 0
      || summary.failed_communities > 0
    ) {
      console.info("[community-membership-projections] reconciled", JSON.stringify(summary))
    }
  } catch (error) {
    console.error("[community-membership-projections] reconciliation failed", error)
    captureScheduledError(env, error, "membership_projection_reconciliation")
  } finally {
    await communityRepository.close?.()
  }
}

const handler: ExportedHandler<Env> = {
  fetch: (req, env, ctx) => fetchWithPublicReadCache(req, env, ctx),

  scheduled: async (_controller, env, ctx) => {
    ctx.waitUntil(withRequestControlPlaneClients(() => flushScheduledAnalytics(env)))
    ctx.waitUntil(withRequestControlPlaneClients(() => syncScheduledCommunityHealthCounts(env)))
    ctx.waitUntil(withRequestControlPlaneClients(() => processScheduledCommunityJobs(env)))
    ctx.waitUntil(withRequestControlPlaneClients(() => reconcileScheduledCommunityMembershipProjections(env)))
    ctx.waitUntil(withRequestControlPlaneClients(() => refreshScheduledMaterializedPublicHomeFeeds(env)))
    ctx.waitUntil(withRequestControlPlaneClients(() => reconcileScheduledRoyaltyClaims(env)))
    ctx.waitUntil(withRequestControlPlaneClients(() => reconcileScheduledPurchaseSettlements(env)))
  },
}

export { app }
export default withSentry(makeSentryOptions, handler)
