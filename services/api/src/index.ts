import { Hono } from "hono"
import { cors } from "hono/cors"
import { captureException, withSentry } from "@sentry/cloudflare"
import agents from "./routes/agents"
import analytics from "./routes/analytics"
import auth from "./routes/auth"
import bookings from "./routes/bookings"
import botUsers from "./routes/bot-users"
import debugPipeline from "./routes/debug-pipeline"
import communityMedia from "./routes/community-media"
import comments from "./routes/comments"
import communities from "./routes/communities"
import discovery from "./routes/discovery"
import karaokeSessions from "./routes/karaoke-sessions"
import feed from "./routes/feed"
import geo from "./routes/geo"
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
import hostBookings from "./routes/host-bookings"
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
import { emptyBookingSettlementSummary, sweepDueBookingSettlements } from "./lib/communities/bookings/booking-settlement-cron"
import { emptyGlobalBookingSettlementSummary, isGlobalBookingSettlementCronEnabled, sweepGlobalBookingSettlements } from "./lib/bookings/booking-settlement-cron"
import { reconcileStaleSongArtifactUploadSessionJobs } from "./lib/communities/jobs/song-artifact-session-reaper-handler"
import { processAvailableCommunityJobs } from "./lib/communities/jobs/runner"
import { reconcileRequestedLockedAssetDeliveryJobs } from "./lib/communities/jobs/locked-asset-delivery-handler"
import { reconcileCommunityMembershipAndFollowProjections } from "./lib/communities/membership/projection-service"
import { HttpError, errorResponse } from "./lib/errors"
import { refreshScheduledMaterializedPublicHomeFeeds } from "./lib/feed/materialized-public-feed"
import { reconcileRoyaltyClaimEvents } from "./lib/royalties/royalty-claim-history"
import { reconcileScheduledD1Provisioning } from "./lib/communities/provisioning/reconciler-host"
import { getControlPlaneClient, withRequestControlPlaneClients } from "./lib/runtime-deps"
import { runScheduledBatch, type NamedTask } from "./lib/scheduled-job-runner"
import { createDurableObjectCronLock, ScheduledCronLockDO } from "./lib/scheduled-cron-lock"
import { makeSentryOptions, captureScheduledError, captureScheduledWarning } from "./lib/sentry"
import { LiveRoomRuntimeDO } from "./lib/communities/live-rooms/runtime"
import { KaraokeSessionRuntimeDO } from "./lib/karaoke/session-do"
import { OperatorSigningCoordinatorDO, registerOperatorChainPrimitives } from "./lib/communities/bookings/operator-signing-coordinator-do"
import { realChain as operatorRealChain } from "./lib/communities/bookings/operator-chain-real"
import type { Env } from "./env"
import {
  publicReadCacheFillRequests,
  publicReadCacheRefreshRequests,
  type PublicReadCacheFillResult,
} from "./lib/public-read-cache-state"

export { resetPublicReadCacheDedupeForTests } from "./lib/public-read-cache-state"
export { LiveRoomRuntimeDO, KaraokeSessionRuntimeDO }
export { ScheduledCronLockDO }
export { OperatorSigningCoordinatorDO }
// Wire the ethers-backed signer into the coordinator DO at worker load. Keeping this out of the DO
// module itself means test worker bundles (which omit this entry) never pull ethers/`ws`.
registerOperatorChainPrimitives(operatorRealChain)

declare const __PIRATE_BUILD_GIT_REF__: string | undefined
declare const __PIRATE_BUILD_GIT_SHA__: string | undefined
declare const __PIRATE_BUILD_TIMESTAMP__: string | undefined

const app = new Hono<{ Bindings: Env }>()
const PUBLIC_READ_WORKER_CACHE_CREATED_HEADER = "x-pirate-cache-created-at"
const PUBLIC_READ_WORKER_CACHE_TTL_HEADER = "x-pirate-cache-ttl"

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
      "Idempotency-Key",
      "X-Admin-As-User-Id",
      "X-Admin-Token",
      "X-Agent-Connection-Token",
      "X-Pirate-Altcha",
      "X-Pirate-Anonymous-Id",
      "X-Pirate-Session-Id",
      "X-Pirate-Submit-Trace-Id",
      "X-Request-Id",
    ],
  }),
)

app.use("*", async (_c, next) => {
  await withRequestControlPlaneClients(next)
})

app.get("/health", (c) => c.json({ ok: true }))
app.get("/health/provisioning", async (c) => {
  const shardConfigured = Boolean(c.env.COMMUNITY_D1_SHARD)
  const regionConfigured = Boolean(String(c.env.COMMUNITY_D1_SHARD_REGION ?? "").trim())
  const ok = shardConfigured && regionConfigured
  return c.json(
    {
      ok,
      backend: "d1_native",
      shard_configured: shardConfigured,
      region_configured: regionConfigured,
      environment: c.env.ENVIRONMENT ?? null,
      ...(ok ? {} : { error_code: "d1_provisioning_unconfigured" }),
    },
    ok ? 200 : 503,
    { "cache-control": "no-store" },
  )
})
app.get("/__version", async (c) => c.json(await buildVersionPayload(c.env), 200, {
  "cache-control": "no-store",
}))
app.route("/", discovery)
app.route("/", agents)
app.route("/analytics", analytics)
app.route("/auth", auth)
app.route("/bookings", bookings)
app.route("/admin/bot-users", botUsers)
app.route("/admin/debug", debugPipeline)
app.route("/community-media", communityMedia)
app.route("/comments", comments)
app.route("/communities", communities)
app.route("/feed", feed)
app.route("/geo", geo)
app.route("/jobs", jobs)
app.route("/karaoke/sessions", karaokeSessions)
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
app.route("/host-bookings", hostBookings)
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
  const canProcessSongPreviewJobs = Boolean(
    env.SONG_PREVIEW_SHARED_SECRET?.trim()
      && (env.SONG_PREVIEW_SERVICE_URL?.trim() || env.SONG_PREVIEW_SERVICE),
  )
  try {
    const reconciledLockedDelivery = await reconcileRequestedLockedAssetDeliveryJobs({
      env,
      communityRepository,
      maxCommunities: 100,
      maxAssetsPerCommunity: 25,
    })
    if (reconciledLockedDelivery.enqueued_jobs > 0 || reconciledLockedDelivery.failed_communities.length > 0) {
      console.info("[community-jobs] reconciled locked delivery jobs", JSON.stringify(reconciledLockedDelivery))
      captureScheduledWarning(
        env,
        "Locked delivery reconciliation enqueued orphaned jobs",
        "community_jobs_locked_delivery_reconciliation",
        reconciledLockedDelivery,
        {
          urgency: reconciledLockedDelivery.enqueued_jobs > 5 ? "high" : "low",
        },
      )
    }
    const reconciledUploadSessions = await reconcileStaleSongArtifactUploadSessionJobs({
      env,
      communityRepository,
      maxCommunities: 100,
    })
    if (reconciledUploadSessions.enqueued_jobs > 0 || reconciledUploadSessions.failed_communities.length > 0) {
      console.info("[community-jobs] reconciled stale song artifact upload sessions", JSON.stringify(reconciledUploadSessions))
      captureScheduledWarning(
        env,
        "Song artifact upload session reaper jobs enqueued",
        "community_jobs_song_artifact_session_reaper",
        reconciledUploadSessions,
        {
          urgency: reconciledUploadSessions.enqueued_jobs > 5 ? "high" : "low",
        },
      )
    }
    const summary = await processAvailableCommunityJobs({
      env,
      communityRepository,
      maxCommunities: 100,
      maxJobsPerCommunity: 25,
      skipJobTypes: canProcessSongPreviewJobs ? [] : ["song_preview_generate"],
    })
    if (summary.processed_jobs > 0 || summary.failed_communities.length > 0) {
      console.info("[community-jobs] scheduled processed", JSON.stringify({
        failed_communities: summary.failed_communities.length,
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

async function reconcileScheduledBookingSettlements(env: Env): Promise<void> {
  // Gated: inert (no enumeration, no settlement) unless BOOKINGS_SETTLEMENT_CRON_ENABLED === "true".
  if (!isGlobalBookingSettlementCronEnabled(env)) return
  let globalSummary = emptyGlobalBookingSettlementSummary(true)
  const communityRepository = getCommunityRepository(env)
  const legacyCommunitySweepEnabled = String(env.LEGACY_COMMUNITY_BOOKINGS_SETTLEMENT_CRON_ENABLED ?? "").trim().toLowerCase() === "true"
  let summary = emptyBookingSettlementSummary(legacyCommunitySweepEnabled)
  try {
    globalSummary = await sweepGlobalBookingSettlements({ env, client: getControlPlaneClient(env), maxBookings: 100, deadlineMs: 20_000 })
    if (legacyCommunitySweepEnabled) {
      summary = await sweepDueBookingSettlements({ env, communityRepository, maxCommunities: 50, maxBookingsPerCommunity: 25, deadlineMs: 20_000 })
    }
    // Sweep classifies enumeration failures fatal without surfacing the raw error; alert on it with a
    // generic marker (no raw message/object reaches Sentry from coordinator/RPC paths).
    if (globalSummary.fatal) captureScheduledError(env, new Error("global_booking_settlement_sweep_fatal"), "global_booking_settlement_reconciliation")
    if (summary.fatal) captureScheduledError(env, new Error("booking_settlement_sweep_fatal"), "booking_settlement_reconciliation")
  } catch (error) {
    // Defense: an unexpected throw past the sweep still yields a fatal summary (no raw error logged).
    summary.errors += 1
    summary.fatal = true
    captureScheduledError(env, error, "booking_settlement_reconciliation")
  } finally {
    // One structured summary for EVERY enabled run — including zero-work AND fatal runs.
    console.info("[global-booking-settlements] swept", JSON.stringify(globalSummary))
    console.info("[booking-settlements] swept", JSON.stringify(summary))
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

// The cron fires every minute. Each scheduled job opens its OWN control-plane
// connection (via withRequestControlPlaneClients) — one connection, opened and
// closed independently, to respect Workers' 15-min waitUntil limit. Running all
// jobs at once opened N connections simultaneously and, coinciding with request
// traffic, burst the control-plane Postgres primary's small max_connections
// (observed: intermittent `remaining connection slots are reserved for SUPERUSER`).
// Cap concurrency so the cron contributes at most SCHEDULED_JOB_CONCURRENCY
// connections at a time; jobs are short so total runtime stays well under 15 min.
// At most this many scheduled jobs run concurrently → the cron contributes
// ≤ SCHEDULED_JOB_CONCURRENCY control-plane connections per invocation.
const SCHEDULED_JOB_CONCURRENCY = 2
// Stop STARTING new jobs after this elapsed wall-time; in-flight jobs (≤ the
// concurrency cap, each internally bounded) finish. Keeps a batch comfortably
// under the 60s cron interval (no overlapping invocations stacking connections)
// and far inside the Worker invocation limit (no mid-flight kill leaking a slot).
const SCHEDULED_BATCH_DEADLINE_MS = 30_000
// Lease longer than the worst-case batch (deadline + slowest in-flight job) so we
// never expire mid-batch, but bounded so a crashed batch self-heals. Released
// promptly on normal completion.
const SCHEDULED_LEASE_TTL_MS = 120_000

const handler: ExportedHandler<Env> = {
  fetch: (req, env, ctx) => fetchWithPublicReadCache(req, env, ctx),

  scheduled: (controller, env, ctx) => {
    // Each job opens its OWN control-plane connection (its own
    // withRequestControlPlaneClients — one connection, opened and closed
    // independently). Bounded concurrency caps peak connections; the deadline
    // bounds when new connections stop opening (it does NOT cancel in-flight
    // jobs — see runner docs / overlap caveat).
    const canRunD1Reconciler = Boolean(env.SHARD_ADMIN_TOKEN && env.COMMUNITY_D1_SHARD)
    const reconcilerOnly = String(env.COMMUNITY_D1_RECONCILER_ONLY ?? "").trim().toLowerCase() === "true"
    // Money-path recovery must not sit behind the rotating best-effort maintenance tail. A live
    // prod tick showed the deadline deferring reconcile_booking_settlements after slower feed /
    // community work, so keep this first while leaving the lower-priority jobs rotated.
    const priorityJobs: NamedTask[] = [
      { name: "reconcile_booking_settlements", run: () => reconcileScheduledBookingSettlements(env) },
    ]
    const generalJobs: NamedTask[] = [
      { name: "flush_analytics", run: () => flushScheduledAnalytics(env) },
      { name: "sync_community_health_counts", run: () => syncScheduledCommunityHealthCounts(env) },
      { name: "process_community_jobs", run: () => processScheduledCommunityJobs(env) },
      { name: "reconcile_membership_projections", run: () => reconcileScheduledCommunityMembershipProjections(env) },
      { name: "refresh_materialized_public_feeds", run: () => refreshScheduledMaterializedPublicHomeFeeds(env) },
      { name: "reconcile_royalty_claims", run: () => reconcileScheduledRoyaltyClaims(env) },
      { name: "reconcile_purchase_settlements", run: () => reconcileScheduledPurchaseSettlements(env) },
    ]
    const rotatedJobs: NamedTask[] = [
      ...(canRunD1Reconciler ? [{ name: "reconcile_d1_provisioning", run: () => reconcileScheduledD1Provisioning(env) }] : []),
      ...(reconcilerOnly ? [] : generalJobs),
    ].map((job) => ({ name: job.name, run: () => withRequestControlPlaneClients(job.run) }))
    // Rotate the start order each minute so a deadline-trimmed tail never starves
    // the same jobs run after run.
    const minute = Math.floor((controller.scheduledTime || Date.now()) / 60_000)
    const offset = rotatedJobs.length > 0 ? ((minute % rotatedJobs.length) + rotatedJobs.length) % rotatedJobs.length : 0
    const ordered = [
      ...priorityJobs.map((job) => ({ name: job.name, run: () => withRequestControlPlaneClients(job.run) })),
      ...rotatedJobs.slice(offset),
      ...rotatedJobs.slice(0, offset),
    ]

    // The DO lease is REQUIRED. Rather than silently run without overlap
    // protection (which could re-trigger control-plane connection exhaustion), a
    // missing binding fails loudly and starts zero jobs — a deploy misconfig to
    // fix immediately, not mask.
    if (!env.SCHEDULED_CRON_LOCK) {
      const error = new Error("SCHEDULED_CRON_LOCK durable object binding is missing; refusing to run the scheduled batch without overlap protection")
      console.error("[scheduled]", error.message)
      captureScheduledError(env, error, "scheduled_cron_lock_binding_missing")
      return
    }
    // A DO lease guarantees only ONE batch runs cluster-wide: if a prior
    // invocation is still in flight, this one acquires nothing and starts zero
    // jobs (so overlapping invocations can't stack control-plane connections).
    const lock = createDurableObjectCronLock(env.SCHEDULED_CRON_LOCK as DurableObjectNamespace<ScheduledCronLockDO>)
    const owner = crypto.randomUUID()
    ctx.waitUntil(
      runScheduledBatch({
        deadlineMs: SCHEDULED_BATCH_DEADLINE_MS,
        leaseTtlMs: SCHEDULED_LEASE_TTL_MS,
        limit: SCHEDULED_JOB_CONCURRENCY,
        lock,
        onError: (error, name) => console.error(`[scheduled] job failed: ${name}`, error),
        onLeaseHeld: () => console.warn("[scheduled] lease held by another invocation — skipping batch (0 jobs started)"),
        onSkipped: (skipped) => console.warn(`[scheduled] deferred ${skipped.length} job(s) past the ${SCHEDULED_BATCH_DEADLINE_MS}ms deadline: ${skipped.join(", ")}`),
        owner,
        tasks: ordered,
      }),
    )
  },
}

export { app }
export default withSentry(makeSentryOptions, handler)
