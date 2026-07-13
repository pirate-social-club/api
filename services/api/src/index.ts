import { Hono } from "hono"
import { cors } from "hono/cors"
import { WorkerEntrypoint } from "cloudflare:workers"
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
import geo from "./routes/geo"
import jobs from "./routes/jobs"
import mcp from "./routes/mcp"
import notifications from "./routes/notifications"
import oauth from "./routes/oauth"
import royalties from "./routes/royalties"
import onboarding from "./routes/onboarding"
import posts from "./routes/posts"
import publicAgents from "./routes/public-agents"
import publicNames from "./routes/public-names"
import publicNamespaces from "./routes/public-namespaces"
import publicProfiles from "./routes/public-profiles"
import profileMedia from "./routes/profile-media"
import profiles from "./routes/profiles"
import rewards from "./routes/rewards"
import hostBookings from "./routes/host-bookings"
import telegram from "./routes/telegram"
import users from "./routes/users"
import verification from "./routes/verification"
import walletIdentities from "./routes/wallet-identities"
import {
  isPublicReadCacheRequest,
} from "./routes/cache-headers"
import { flushAnalyticsOutbox, isAnalyticsEnabled, syncCommunityHealthCounts } from "./lib/analytics"
import { getCommunityRepository } from "./lib/communities/db-community-repository"
import { reconcileStaleCommunityPurchaseSettlements } from "./lib/communities/commerce/settlement-service"
import { emptyBookingSettlementSummary, sweepDueBookingSettlements } from "./lib/communities/bookings/booking-settlement-cron"
import { emptyGlobalBookingSettlementSummary, isGlobalBookingSettlementCronEnabled, sweepGlobalBookingSettlements } from "./lib/bookings/booking-settlement-cron"
import { reconcileStaleSongArtifactUploadSessionJobs } from "./lib/communities/jobs/song-artifact-session-reaper-handler"
import { processAvailableCommunityJobs } from "./lib/communities/jobs/runner"
import { reconcileRequestedLockedAssetDeliveryJobs } from "./lib/communities/jobs/locked-asset-delivery-handler"
import { reconcileStuckPostPublishFinalizeJobs } from "./lib/communities/jobs/post-publish-finalize-handler"
import { reconcileCommunityMembershipAndFollowProjections } from "./lib/communities/membership/projection-service"
import { refreshScheduledMaterializedPublicHomeFeeds } from "./lib/feed/materialized-public-feed"
import { reconcileRoyaltyClaimEvents } from "./lib/royalties/royalty-claim-history"
import { reconcileStoryRoyaltyAllocationVerifications } from "./lib/communities/commerce/royalty-allocation-verifier"
import { reconcileScheduledD1Provisioning } from "./lib/communities/provisioning/reconciler-host"
import {
  checkScheduledD1PoolCapacity,
  classifyD1PoolCapacity,
} from "./lib/communities/provisioning/pool-capacity-watchdog"
import { getControlPlaneClient, withRequestControlPlaneClients } from "./lib/runtime-deps"
import { runScheduledBatch, type NamedTask } from "./lib/scheduled-job-runner"
import { createDurableObjectCronLock, ScheduledCronLockDO } from "./lib/scheduled-cron-lock"
import { runStoryRuntimeFundingWatchdog } from "./lib/story/story-runtime-funding-watchdog"
import { reconcileSongPracticeRewards } from "./lib/rewards/song-practice-reconciler"
import { reconcileSubmittedRewardPayouts } from "./lib/rewards/reward-cashout-service"
import { reconcileRewardCampaigns } from "./lib/rewards/reward-campaign-reconciler"
import { markRewardCampaignIncidentAlerted, monitorRewardCampaigns } from "./lib/rewards/reward-campaign-monitor"
import { runOpsAlerts } from "./lib/ops-alerts/run"
import { captureScheduledError, captureScheduledWarning } from "./lib/ops-alerts/scheduled"
import { LiveRoomRuntimeDO } from "./lib/communities/live-rooms/runtime"
import { KaraokeSessionRuntimeDO } from "./lib/karaoke/session-do"
import { OperatorSigningCoordinatorDO, registerOperatorChainPrimitives } from "./lib/communities/bookings/operator-signing-coordinator-do"
import { realChain as operatorRealChain } from "./lib/communities/bookings/operator-chain-real"
import type { Env } from "./env"
import publicReadApp from "./routes/public-read-app"
import { apiErrorHandler } from "./routes/api-error-handler"

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

type PublicReadEntrypoint = {
  fetch(request: Request): Promise<Response>
}

type PublicReadExecutionContext = ExecutionContext & {
  exports?: {
    CachedPublicReads?: PublicReadEntrypoint
  }
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
  async (c, next) => {
    if (isPublicReadCacheRequest(c.req.raw)) {
      await next()
      return
    }

    return cors({
      origin: configuredCorsOrigin,
      allowMethods: CORS_ALLOW_METHODS,
      allowHeaders: CORS_ALLOW_HEADERS,
    })(c, next)
  },
)

app.use("*", async (_c, next) => {
  await withRequestControlPlaneClients(next)
})

app.get("/health", (c) => c.json({ ok: true }))
app.get("/health/provisioning", async (c) => {
  const shardConfigured = Boolean(c.env.COMMUNITY_D1_SHARD)
  const regionConfigured = Boolean(String(c.env.COMMUNITY_D1_SHARD_REGION ?? "").trim())
  const adminConfigured = Boolean(c.env.SHARD_ADMIN_TOKEN)
  if (!shardConfigured || !regionConfigured || !adminConfigured) {
    return c.json(
      {
        ok: false,
        backend: "d1_native",
        shard_configured: shardConfigured,
        region_configured: regionConfigured,
        admin_configured: adminConfigured,
        environment: c.env.ENVIRONMENT ?? null,
        error_code: "d1_provisioning_unconfigured",
      },
      503,
      { "cache-control": "no-store" },
    )
  }

  const result = await c.env.COMMUNITY_D1_SHARD!.communityD1PoolStats({
    adminToken: c.env.SHARD_ADMIN_TOKEN!,
  })
  if (!result.ok) {
    return c.json(
      {
        ok: false,
        backend: "d1_native",
        shard_configured: true,
        region_configured: true,
        admin_configured: true,
        environment: c.env.ENVIRONMENT ?? null,
        error_code: "d1_pool_stats_unavailable",
      },
      503,
      { "cache-control": "no-store" },
    )
  }

  const capacity = classifyD1PoolCapacity(result.value, c.env.COMMUNITY_D1_POOL_FREE_ALERT_THRESHOLD)
  const ok = capacity.healthy
  return c.json(
    {
      ok,
      backend: "d1_native",
      shard_configured: true,
      region_configured: true,
      admin_configured: true,
      environment: c.env.ENVIRONMENT ?? null,
      pool_capacity: capacity,
      ...(ok ? {} : { error_code: "d1_pool_low_capacity" }),
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
app.route("/", publicReadApp)
app.route("/geo", geo)
app.route("/jobs", jobs)
app.route("/karaoke/sessions", karaokeSessions)
app.route("/mcp", mcp)
app.route("/notifications", notifications)
app.route("/oauth", oauth)
app.route("/royalties", royalties)
app.route("/posts", posts)
app.route("/public-agents", publicAgents)
app.route("/public-names", publicNames)
app.route("/public-namespaces", publicNamespaces)
app.route("/public-profiles", publicProfiles)
app.route("/profile-media", profileMedia)
app.route("/users", users)
app.route("/onboarding", onboarding)
app.route("/profiles", profiles)
app.route("/", rewards)
app.route("/host-bookings", hostBookings)
app.route("/telegram", telegram)
app.route("/wallet-identities", walletIdentities)
app.route("/", verification)

app.post("/__debug/ops-alert", async (c) => {
  if (c.env.ENVIRONMENT === "production") {
    return c.json({ error: "not_found" }, 404)
  }
  await captureScheduledWarning(
    c.env,
    "Ops alert smoke test",
    "ops_alert_smoke_test",
    { source: "__debug/ops-alert" },
    { urgency: "high" },
  )
  return c.json({ ok: true })
})

app.notFound((c) => c.json({ code: "not_found", message: "Not found" }, 404))

app.onError(apiErrorHandler)

async function fetchPublicRead(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const forwarded = buildPublicReadEntrypointRequest(req)
  const publicReadContext = ctx as PublicReadExecutionContext
  const exportedEntrypoint = publicReadContext.exports?.CachedPublicReads
  if (exportedEntrypoint) {
    return exportedEntrypoint.fetch(forwarded)
  }
  return publicReadApp.fetch(forwarded, env, ctx)
}

function buildPublicReadEntrypointRequest(req: Request): Request {
  const headers = new Headers(req.headers)
  headers.delete("Authorization")
  headers.delete("Origin")
  return new Request(req.url, {
    headers,
    method: "GET",
  })
}

const CORS_ALLOW_METHODS = ["GET", "POST", "PUT", "DELETE", "OPTIONS"]
const CORS_ALLOW_HEADERS = [
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
]
function appendVaryHeader(headers: Headers, field: string): void {
  const existing = (headers.get("Vary") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  const existingLower = new Set(existing.map((value) => value.toLowerCase()))
  if (!existingLower.has(field.toLowerCase())) {
    headers.set("Vary", [...existing, field].join(", "))
  }
}

function applyCorsHeaders(request: Request, response: Response, env: Env): Response {
  if (response.headers.has("Access-Control-Allow-Origin")) {
    return response
  }

  const origin = request.headers.get("Origin")
  if (!origin) {
    return response
  }

  const allowedOrigin = configuredCorsOrigin(origin, { env })
  if (!allowedOrigin) {
    return response
  }

  const next = new Response(response.body, response)
  next.headers.set("Access-Control-Allow-Origin", allowedOrigin)
  appendVaryHeader(next.headers, "Origin")
  return next
}

async function fetchApi(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const response = isPublicReadCacheRequest(req)
    ? await fetchPublicRead(req, env, ctx)
    : await app.fetch(req, env, ctx)
  return applyCorsHeaders(req, response, env)
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
    await captureScheduledError(env, error, "analytics_flush")
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
    await captureScheduledError(env, error, "community_health_sync")
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
    await captureScheduledError(env, error, "community_health_sync")
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
      await captureScheduledWarning(
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
      await captureScheduledWarning(
        env,
        "Song artifact upload session reaper jobs enqueued",
        "community_jobs_song_artifact_session_reaper",
        reconciledUploadSessions,
        {
          urgency: reconciledUploadSessions.enqueued_jobs > 5 ? "high" : "low",
        },
      )
    }
    const reconciledPostPublishFinalize = await reconcileStuckPostPublishFinalizeJobs({
      env,
      communityRepository,
      maxCommunities: 100,
      maxPostsPerCommunity: 25,
    })
    if (reconciledPostPublishFinalize.failed_posts > 0 || reconciledPostPublishFinalize.failed_communities.length > 0) {
      console.info("[community-jobs] reconciled stuck post publish finalize jobs", JSON.stringify(reconciledPostPublishFinalize))
      const postPublishFinalizeMessage = reconciledPostPublishFinalize.failed_posts > 0
        ? "Post publish finalize reconciliation marked stuck posts failed"
        : "Post publish finalize reconciliation had community routing failures"
      await captureScheduledWarning(
        env,
        postPublishFinalizeMessage,
        "community_jobs_post_publish_finalize_reconciliation",
        reconciledPostPublishFinalize,
        {
          urgency: reconciledPostPublishFinalize.failed_posts > 5
            ? "high"
            : reconciledPostPublishFinalize.failed_posts > 0
              ? "medium"
              : "low",
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
    await runOpsAlerts({ env, communityRepository, nowMs: Date.now() })
  } catch (error) {
    console.error("[community-jobs] scheduled processing failed", error)
    await captureScheduledError(env, error, "community_jobs")
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
    await captureScheduledError(env, error, "royalty_reconciliation")
  }
}

async function reconcileScheduledRoyaltyAllocationVerifications(env: Env): Promise<void> {
  const communityRepository = getCommunityRepository(env)
  try {
    const summary = await reconcileStoryRoyaltyAllocationVerifications({
      env,
      communityRepository,
      maxCommunities: 100,
      maxAssetsPerCommunity: 10,
    })
    if (summary.checked > 0 || summary.failed > 0 || summary.failed_communities.length > 0) {
      console.info("[royalty-allocations] reconciled verification", JSON.stringify(summary))
    }
  } catch (error) {
    console.error("[royalty-allocations] verification reconciliation failed", error)
    await captureScheduledError(env, error, "royalty_allocation_verification")
  } finally {
    await communityRepository.close?.()
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
    await captureScheduledError(env, error, "purchase_settlement_reconciliation")
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
    // generic marker (no raw message/object reaches alert sinks from coordinator/RPC paths).
    if (globalSummary.fatal) await captureScheduledError(env, new Error("global_booking_settlement_sweep_fatal"), "global_booking_settlement_reconciliation")
    if (summary.fatal) await captureScheduledError(env, new Error("booking_settlement_sweep_fatal"), "booking_settlement_reconciliation")
  } catch (error) {
    // Defense: an unexpected throw past the sweep still yields a fatal summary (no raw error logged).
    summary.errors += 1
    summary.fatal = true
    await captureScheduledError(env, error, "booking_settlement_reconciliation")
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
    await captureScheduledError(env, error, "membership_projection_reconciliation")
  } finally {
    await communityRepository.close?.()
  }
}

async function reconcileScheduledSongPracticeRewards(env: Env): Promise<void> {
  const communityRepository = getCommunityRepository(env)
  try {
    const summary = await reconcileSongPracticeRewards({
      env,
      communityRepository,
      controlPlaneClient: getControlPlaneClient(env),
      maxCommunities: 50,
      maxQualifiedDaysPerCommunity: 500,
    })
    if (
      summary.enabled
      && (
        summary.credited_events > 0
        || summary.skipped_cap_cents > 0
        || summary.failed_communities > 0
      )
    ) {
      console.info("[rewards] reconciled song practice rewards", JSON.stringify(summary))
    }
  } catch (error) {
    console.error("[rewards] reconciliation failed", error)
    await captureScheduledError(env, error, "song_practice_rewards_reconciliation")
  } finally {
    await communityRepository.close?.()
  }
}

async function reconcileScheduledRewardPayouts(env: Env): Promise<void> {
  try {
    const summary = await reconcileSubmittedRewardPayouts({
      env,
      client: getControlPlaneClient(env),
      limit: 50,
      confirmPollMs: [],
    })
    if (
      summary.enabled
      && (
        summary.confirmed > 0
        || summary.failed > 0
        || summary.pending > 0
        || summary.errors > 0
      )
    ) {
      console.info("[rewards] reconciled submitted reward payouts", JSON.stringify(summary))
    }
  } catch (error) {
    console.error("[rewards] payout reconciliation failed", error)
    await captureScheduledError(env, error, "reward_payout_reconciliation")
  }
}

async function monitorScheduledRewardCampaigns(env: Env): Promise<void> {
  try {
    const client = getControlPlaneClient(env)
    const summary = await monitorRewardCampaigns({ env, client, limit: 100 })
    if (summary.heartbeat_stale) {
      await captureScheduledWarning(
        env,
        "Reward campaign integrity monitor heartbeat was stale",
        "reward_campaign_integrity_heartbeat",
        { errors: 1 },
        { urgency: "high" },
      )
    }
    if (summary.transient_finality_checks > 0) {
      await captureScheduledWarning(
        env,
        "Reward campaign integrity scan had indeterminate finality checks",
        "reward_campaign_integrity_rpc",
        { errors: summary.transient_finality_checks },
        { urgency: "high" },
      )
    }
    if (summary.incidents.length > 0) {
      console.warn("[reward-campaigns] integrity incidents", JSON.stringify(summary))
      for (const incident of summary.incidents) {
        const delivered = await captureScheduledWarning(
          env,
          "Reward campaign integrity incident",
          `reward_campaign_integrity:${incident.incident_id}`,
          { campaign_id: incident.campaign_id, incident_kind: incident.kind, reason: incident.reason },
          { urgency: incident.kind === "funding_provenance_missing" ? "low" : "high" },
        )
        if (delivered) {
          await markRewardCampaignIncidentAlerted({
            client,
            incidentId: incident.incident_id,
          })
        }
      }
    }
  } catch (error) {
    console.error("[reward-campaigns] integrity monitor failed", error)
    await captureScheduledError(env, error, "reward_campaign_integrity_monitor")
  }
}

async function reconcileScheduledRewardCampaigns(env: Env): Promise<void> {
  const communityRepository = getCommunityRepository(env)
  try {
    const summary = await reconcileRewardCampaigns({
      env,
      communityRepository,
      controlPlaneClient: getControlPlaneClient(env),
      maxCommunities: 50,
      maxCredits: 500,
      outboxBatchSize: 500,
    })
    if (summary.enabled && (
      summary.ingested_qualifications > 0
      || summary.credited_events > 0
      || summary.skipped_budget > 0
      || summary.skipped_expired > 0
      || summary.skipped_owner_blocked > 0
      || summary.skipped_no_campaign > 0
      || summary.failed_communities > 0
      || summary.errors > 0
    )) {
      console.info("[reward-campaigns] reconciled", JSON.stringify(summary))
    }
  } catch (error) {
    console.error("[reward-campaigns] reconciliation failed", error)
    await captureScheduledError(env, error, "reward_campaign_reconciliation")
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

type ScheduledPriorityJobName =
  | "reconcile_booking_settlements"
  | "reconcile_royalty_allocation_verifications"
  | "reconcile_d1_provisioning"
  | "monitor_reward_campaigns"

export function scheduledPriorityJobNames(canRunD1Reconciler: boolean): ScheduledPriorityJobName[] {
  return [
    "reconcile_booking_settlements",
    "reconcile_royalty_allocation_verifications",
    ...(canRunD1Reconciler ? ["reconcile_d1_provisioning" as const] : []),
    "monitor_reward_campaigns",
  ]
}

const handler: ExportedHandler<Env> = {
  fetch: fetchApi,

  scheduled: (controller, env, ctx) => {
    // Story signer funding watchdog. Read-only RPC (no control-plane connection),
    // internally rate-limited and fully fail-soft, so it runs independently of the
    // DO-leased batch below and cannot destabilise it.
    ctx.waitUntil(
      runStoryRuntimeFundingWatchdog(env).catch((error) => {
        console.error("[scheduled] story funding watchdog crashed (fail-soft)", error)
      }),
    )
    ctx.waitUntil(
      checkScheduledD1PoolCapacity(env).catch((error) => {
        console.error("[scheduled] community D1 pool capacity watchdog crashed (fail-soft)", error)
      }),
    )

    // Each job opens its OWN control-plane connection (its own
    // withRequestControlPlaneClients — one connection, opened and closed
    // independently). Bounded concurrency caps peak connections; the deadline
    // bounds when new connections stop opening (it does NOT cancel in-flight
    // jobs — see runner docs / overlap caveat).
    const canRunD1Reconciler = Boolean(env.SHARD_ADMIN_TOKEN && env.COMMUNITY_D1_SHARD)
    const reconcilerOnly = String(env.COMMUNITY_D1_RECONCILER_ONLY ?? "").trim().toLowerCase() === "true"
    // Recovery and money-path verification must not sit behind the rotating best-effort
    // maintenance tail. Live ticks have shown the deadline deferring settlement, D1
    // provisioning, and royalty-allocation verification after slower community/feed work,
    // so keep them first while lower-priority jobs rotate.
    const priorityJobRuns: Record<ScheduledPriorityJobName, () => Promise<void>> = {
      reconcile_booking_settlements: () => reconcileScheduledBookingSettlements(env),
      reconcile_royalty_allocation_verifications: () => reconcileScheduledRoyaltyAllocationVerifications(env),
      reconcile_d1_provisioning: () => reconcileScheduledD1Provisioning(env),
      monitor_reward_campaigns: () => monitorScheduledRewardCampaigns(env),
    }
    // Concurrency is two: royalty verification keeps the second start slot. D1
    // remains ahead of the slower, latency-tolerant reward monitor so RPC latency
    // cannot reintroduce provisioning starvation at the task-start deadline.
    const priorityJobs: NamedTask[] = scheduledPriorityJobNames(canRunD1Reconciler)
      .map((name) => ({ name, run: priorityJobRuns[name] }))
    const generalJobs: NamedTask[] = [
      { name: "flush_analytics", run: () => flushScheduledAnalytics(env) },
      { name: "sync_community_health_counts", run: () => syncScheduledCommunityHealthCounts(env) },
      { name: "process_community_jobs", run: () => processScheduledCommunityJobs(env) },
      { name: "reconcile_membership_projections", run: () => reconcileScheduledCommunityMembershipProjections(env) },
      { name: "reconcile_song_practice_rewards", run: () => reconcileScheduledSongPracticeRewards(env) },
      { name: "reconcile_reward_campaigns", run: () => reconcileScheduledRewardCampaigns(env) },
      { name: "reconcile_reward_payouts", run: () => reconcileScheduledRewardPayouts(env) },
      { name: "refresh_materialized_public_feeds", run: () => refreshScheduledMaterializedPublicHomeFeeds(env) },
      { name: "reconcile_royalty_claims", run: () => reconcileScheduledRoyaltyClaims(env) },
      { name: "reconcile_purchase_settlements", run: () => reconcileScheduledPurchaseSettlements(env) },
    ]
    const rotatedJobs: NamedTask[] = [
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
      ctx.waitUntil(captureScheduledError(env, error, "scheduled_cron_lock_binding_missing"))
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

export class CachedPublicReads extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    return withRequestControlPlaneClients(async () => publicReadApp.fetch(request, this.env, this.ctx))
  }
}

export { app }
export default handler
