import { Hono } from "hono"
import { cors } from "hono/cors"
import { WorkerEntrypoint } from "cloudflare:workers"
import type { ShardVersionInfo } from "@pirate/api-shared"
import { KARAOKE_SCORING_VERSION } from "@pirate-social-club/karaoke-runtime"
import { KARAOKE_RUNTIME_BUILD } from "@pirate-social-club/karaoke-runtime/build"
import agents from "./routes/agents"
import analytics from "./routes/analytics"
import auth from "./routes/auth"
import bookings from "./routes/bookings"
import danceChoreographies from "./routes/dance-choreographies"
import postDanceChoreographies from "./routes/post-dance-choreographies"
import danceSessions from "./routes/dance-sessions"
import danceAttempts from "./routes/dance-attempts"
import botUsers from "./routes/bot-users"
import debugPipeline from "./routes/debug-pipeline"
import opsTelegramDeliveries from "./routes/ops-telegram-deliveries"
import opsWallets from "./routes/ops-wallets"
import hnsEdgeAlerts from "./routes/hns-edge-alerts"
import hnsWalletOriginOps from "./routes/hns-wallet-origin-ops"
import communityMedia from "./routes/community-media"
import comments from "./routes/comments"
import communities from "./routes/communities"
import discovery from "./routes/discovery"
import karaokeSessions from "./routes/karaoke-sessions"
import geo from "./routes/geo"
import gateCapabilities from "./routes/gate-capabilities"
import jobs from "./routes/jobs"
import mcp from "./routes/mcp"
import notifications from "./routes/notifications"
import oauth from "./routes/oauth"
import royalties from "./routes/royalties"
import storySettlementOps from "./routes/story-settlement-ops"
import contentSecurityOps from "./routes/content-security-ops"
import onboarding from "./routes/onboarding"
import posts from "./routes/posts"
import publicAgents from "./routes/public-agents"
import publicNames from "./routes/public-names"
import publicNamespaces from "./routes/public-namespaces"
import publicProfiles from "./routes/public-profiles"
import profileMedia from "./routes/profile-media"
import profiles from "./routes/profiles"
import privyRelay from "./routes/privy-relay"
import rewards from "./routes/rewards"
import hostBookings from "./routes/host-bookings"
import telegram from "./routes/telegram"
import users from "./routes/users"
import verification from "./routes/verification"
import walletIdentities from "./routes/wallet-identities"
import {
  isPublicReadCacheRequest,
} from "./routes/cache-headers"
import {
  flushAnalyticsOutbox,
  isCommunityHealthSyncSaturationError,
  isAnalyticsEnabled,
  pruneAnalyticsOutbox,
  syncCommunityHealthCounts,
} from "./lib/analytics"
import { getCommunityRepository } from "./lib/communities/db-community-repository"
import { reconcileStaleCommunityPurchaseSettlements } from "./lib/communities/commerce/settlement-service"
import { emptyGlobalBookingSettlementSummary, isGlobalBookingSettlementCronEnabled, sweepGlobalBookingSettlements } from "./lib/bookings/booking-settlement-cron"
import {
  emptyBookingPaymentReverificationSummary,
  isBookingPaymentReverificationCronEnabled,
  sweepClaimedBookingPaymentIntents,
} from "./lib/bookings/booking-payment-reverification-cron"
import { createBookingHoldWriteRepository } from "./lib/bookings/hold-repository"
import { getUserRepository } from "./lib/auth/repositories"
import { reconcileStaleSongArtifactUploadSessionJobs } from "./lib/communities/jobs/song-artifact-session-reaper-handler"
import { reconcileHeadVerifyingSongArtifactUploads } from "./lib/song-artifacts/song-artifact-upload-session-service"
import { exhaustedCommunityJobs, processAvailableCommunityJobs } from "./lib/communities/jobs/runner"
import { reconcileRequestedLockedAssetDeliveryJobs } from "./lib/communities/jobs/locked-asset-delivery-handler"
import { reconcileStuckPostPublishFinalizeJobs } from "./lib/communities/jobs/post-publish-finalize-handler"
import { listActiveTelegramChannelCommunityIds } from "./lib/telegram/channel-destination-service"
import { reconcileCommunityMembershipAndFollowProjections } from "./lib/communities/membership/projection-service"
import { refreshScheduledMaterializedPublicHomeFeeds } from "./lib/feed/materialized-public-feed"
import { reconcileRoyaltyClaimEvents } from "./lib/royalties/royalty-claim-history"
import { reconcileStoryRoyaltyAllocationVerifications } from "./lib/communities/commerce/royalty-allocation-verifier"
import { expireUnclaimedContentBlobs } from "./lib/content-blobs/content-blob-repository"
import { reconcileGenericAssetPayloads } from "./lib/content-blobs/generic-asset-reconciler"
import { reconcileDeckImportPlaintextRetention } from "./lib/content-blobs/deck-import-retention"
import { reconcileScheduledD1Provisioning } from "./lib/communities/provisioning/reconciler-host"
import {
  checkScheduledD1PoolCapacity,
  classifyD1PoolCapacity,
  readD1PoolStats,
} from "./lib/communities/provisioning/pool-capacity-watchdog"
import {
  listConfiguredCommunityShards,
  resolveCommunityAllocationShard,
} from "./lib/communities/community-shard-registry"
import { getControlPlaneClient, withRequestControlPlaneClients } from "./lib/runtime-deps"
import {
  configuredCorsOrigin as configuredCorsOriginForEnv,
  importedHnsAppRoot,
  importedHnsRootLabel,
} from "./lib/http/allowed-origins"
import {
  hnsWalletOriginAuthorityStub,
  type HnsRootRoutingAuthoritySnapshot,
} from "./lib/hns-wallet-origin-authority-do"
import {
  HNS_ROOT_ROUTING_AUTHORITY_TTL_MS,
  readHnsRootRoutingAuthority,
} from "./lib/hns-root-routing-authority"
import { mirrorResponseToRequestHost } from "./lib/http/request-host-mirror"
import { runScheduledBatch, type NamedTask } from "./lib/scheduled-job-runner"
import { createDurableObjectCronLock, ScheduledCronLockDO } from "./lib/scheduled-cron-lock"
import { splitScheduledLanes } from "./lib/scheduled-lanes"
import { checkHnsEdgeHeartbeatFreshness } from "./lib/ops-alerts/hns-edge-heartbeats"
import {
  EFP_INDEXER_CHAINS,
  scanEfpChainOnce,
  type EfpIndexerChainConfig,
} from "./lib/efp-indexer/scanner"
import {
  reconcilePendingFollowWrites,
  recordEfpFollowAdoptionSnapshot,
  readEfpFollowWeeklyAdoptionReport,
} from "./lib/efp-indexer/follow-write-service"
import { reconcilePendingPrivyFollowSubmissions } from "./lib/efp-indexer/follow-sponsorship-relay"
import {
  isHnsRootObserverEnabled,
  observeDueHnsRoots,
} from "./lib/hns-root-observer/cron"
import { runStoryRuntimeFundingWatchdog } from "./lib/story/story-runtime-funding-watchdog"
import { runStorySettlementCoordinatorWatchdog } from "./lib/story/story-settlement-coordinator-watchdog"
import { reconcileSongPracticeRewards } from "./lib/rewards/song-practice-reconciler"
import { reconcileSubmittedRewardPayouts } from "./lib/rewards/reward-cashout-service"
import { reconcileRewardCampaigns } from "./lib/rewards/reward-campaign-reconciler"
import { consumeRewardQualificationWakeups } from "./lib/rewards/reward-qualification-wakeup-consumer"
import type { RewardQualificationWakeup } from "./lib/rewards/reward-qualification-wakeup"
import { consumeContentSecurityScans } from "./lib/content-security/content-security-consumer"
import {
  isContentSecurityScanQueueName,
  redispatchStaleContentSecurityScanJobs,
} from "./lib/content-security/content-security-queue"
import type { ContentSecurityScanMessage } from "./lib/content-security/content-security-types"
import { runWithRewardReconciliationLock } from "./lib/rewards/reward-reconciliation-lock"
import { reconcileRewardFundingRefunds } from "./lib/rewards/reward-funding-refund-reconciler"
import {
  classifyHandleClaimFinalizationError,
  reconcileFundedHandleClaimIntents,
} from "./lib/communities/handles/handle-claim-finalization-reconciler"
import { reconcileHandleClaimRefunds } from "./lib/communities/handles/handle-claim-refund-reconciler"
import {
  finalizeFundedHandleClaimOnShard,
  finalizedHandleId,
} from "./lib/communities/handles/handle-claim-intent-finalizer"
import { resolveFundedHandleReservationSeconds } from "./lib/communities/handles/handle-claim-intent-config"
import { openCommunityWriteClient } from "./lib/communities/community-read-access"
import { reconcileConfirmingRewardCampaignFunding } from "./lib/rewards/reward-funding-confirmation-reconciler"
import {
  dispatchDueDanceReferences,
  isDanceReferenceDispatchConfigured,
} from "./lib/dance/choreography-reference-dispatch"
import {
  dispatchDueDanceAttempts,
  isDanceAttemptDispatchConfigured,
} from "./lib/dance/attempt-dispatch"
import { cleanupDueDanceAttempts } from "./lib/dance/attempt-cleanup"
import { terminalizeExhaustedDanceAttempts } from "./lib/dance/attempt-lifecycle"
import { markRewardCampaignIncidentAlerted, monitorRewardCampaigns } from "./lib/rewards/reward-campaign-monitor"
import { runRewardCampaignMonitorCycle } from "./lib/rewards/reward-campaign-monitor-cycle"
import { runOpsAlerts } from "./lib/ops-alerts/run"
import { runRuntimeWalletFundingWatchdog } from "./lib/ops-alerts/runtime-wallet-funding-watchdog"
import { monitorRewardCampaignTreasurySolvency } from "./lib/rewards/reward-campaign-solvency-monitor"
import { enforceRewardNationalityDecisionRetention } from "./lib/rewards/reward-nationality-retention"
import { captureScheduledError, captureScheduledWarning } from "./lib/ops-alerts/scheduled"
import {
  runPublicReadCacheCanary,
  shouldRunPublicReadCacheCanary,
} from "./lib/public-read-cache-canary"
import {
  hnsNamespaceRevalidationAlertState,
  isHnsNamespaceRevalidationEnabled,
  sweepHnsNamespaceRevalidations,
} from "./lib/verification/namespace-revalidation-cron"
import { LiveRoomRuntimeDO } from "./lib/communities/live-rooms/runtime"
import { KaraokeSessionRuntimeDO } from "./lib/karaoke/session-do"
import { OperatorSigningCoordinatorDO, registerOperatorChainPrimitives } from "./lib/communities/bookings/operator-signing-coordinator-do"
import {
  StorySettlementWalletCoordinatorDO,
  registerStorySettlementChainPrimitives,
} from "./lib/story/story-settlement-wallet-coordinator-do"
import { storySettlementRealChain } from "./lib/story/story-settlement-chain-real"
import { CommentCreateRateLimiterDO } from "./lib/comment-create-rate-limit"
import { HnsWalletOriginAuthorityDO } from "./lib/hns-wallet-origin-authority-do"
import { realChain as operatorRealChain } from "./lib/communities/bookings/operator-chain-real"
import type { Env } from "./env"
import publicReadApp from "./routes/public-read-app"
import { apiErrorHandler } from "./routes/api-error-handler"
import { authenticateAdminAccessOnly } from "./lib/auth-middleware"
import { ADMIN_DEBUG_ACCESS_SCOPE } from "./lib/operator-credential-auth"
import {
  REQUEST_ID_HEADER,
  requestCorrelationMiddleware,
  type RequestCorrelationEnv,
} from "./lib/request-correlation"

export { LiveRoomRuntimeDO, KaraokeSessionRuntimeDO }
export { ScheduledCronLockDO }
export { OperatorSigningCoordinatorDO }
export { StorySettlementWalletCoordinatorDO }
export { CommentCreateRateLimiterDO }
export { HnsWalletOriginAuthorityDO }
// Wire the ethers-backed signer into the coordinator DO at worker load. Keeping this out of the DO
// module itself means test worker bundles (which omit this entry) never pull ethers/`ws`.
registerOperatorChainPrimitives(operatorRealChain)
registerStorySettlementChainPrimitives(storySettlementRealChain)

declare const __PIRATE_BUILD_GIT_REF__: string | undefined
declare const __PIRATE_BUILD_GIT_SHA__: string | undefined
declare const __PIRATE_BUILD_TIMESTAMP__: string | undefined
declare const __PIRATE_BUILD_RELEASE_ID__: string | undefined
declare const __PIRATE_BUILD_ID__: string | undefined
declare const __PIRATE_BUILD_WEB_SHA__: string | undefined
declare const __PIRATE_BUILD_API_SHA__: string | undefined
declare const __PIRATE_BUILD_CORE_SHA__: string | undefined
declare const __PIRATE_BUILD_SOURCE_STATE__: string | undefined
declare const __PIRATE_BUILD_DEPLOY_REASON_SLUG__: string | undefined
declare const __PIRATE_BUILD_HOTFIX_REASON_SLUG__: string | undefined
declare const __PIRATE_BUILD_PATCH_SHA256__: string | undefined
declare const __PIRATE_COMMUNITY_D1_SHARD_SOURCE_VERSION__: string | undefined

const app = new Hono<RequestCorrelationEnv>()

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
  release_id: string | null
  build_id: string | null
  web_sha: string | null
  api_sha: string | null
  core_sha: string | null
  source_state: "clean" | "dirty" | null
  deploy_reason_slug: string | null
  hotfix_reason_slug: string | null
  patch_sha256: string | null
}

const COMPILED_BUILD_VERSION_METADATA: BuildVersionMetadata = {
  git_ref: typeof __PIRATE_BUILD_GIT_REF__ === "string" ? __PIRATE_BUILD_GIT_REF__ : null,
  git_sha: typeof __PIRATE_BUILD_GIT_SHA__ === "string" ? __PIRATE_BUILD_GIT_SHA__ : null,
  build_timestamp: typeof __PIRATE_BUILD_TIMESTAMP__ === "string" ? __PIRATE_BUILD_TIMESTAMP__ : null,
  release_id: typeof __PIRATE_BUILD_RELEASE_ID__ === "string" ? __PIRATE_BUILD_RELEASE_ID__ : null,
  build_id: typeof __PIRATE_BUILD_ID__ === "string" ? __PIRATE_BUILD_ID__ : null,
  web_sha: typeof __PIRATE_BUILD_WEB_SHA__ === "string" ? __PIRATE_BUILD_WEB_SHA__ : null,
  api_sha: typeof __PIRATE_BUILD_API_SHA__ === "string" ? __PIRATE_BUILD_API_SHA__ : null,
  core_sha: typeof __PIRATE_BUILD_CORE_SHA__ === "string" ? __PIRATE_BUILD_CORE_SHA__ : null,
  source_state: typeof __PIRATE_BUILD_SOURCE_STATE__ === "string"
    && (__PIRATE_BUILD_SOURCE_STATE__ === "clean" || __PIRATE_BUILD_SOURCE_STATE__ === "dirty")
      ? __PIRATE_BUILD_SOURCE_STATE__
      : null,
  deploy_reason_slug: typeof __PIRATE_BUILD_DEPLOY_REASON_SLUG__ === "string"
    ? __PIRATE_BUILD_DEPLOY_REASON_SLUG__ || null
    : null,
  hotfix_reason_slug: typeof __PIRATE_BUILD_HOTFIX_REASON_SLUG__ === "string"
    ? __PIRATE_BUILD_HOTFIX_REASON_SLUG__ || null
    : null,
  patch_sha256: typeof __PIRATE_BUILD_PATCH_SHA256__ === "string"
    ? __PIRATE_BUILD_PATCH_SHA256__ || null
    : null,
}

const COMPILED_COMMUNITY_D1_SHARD_SOURCE_VERSION =
  typeof __PIRATE_COMMUNITY_D1_SHARD_SOURCE_VERSION__ === "string"
    ? __PIRATE_COMMUNITY_D1_SHARD_SOURCE_VERSION__
    : null

export function expectedCommunityD1ShardSourceVersion(
  env: Pick<Env, "COMMUNITY_D1_SHARD_SOURCE_VERSION">,
): string | null {
  return env.COMMUNITY_D1_SHARD_SOURCE_VERSION
    ?? COMPILED_COMMUNITY_D1_SHARD_SOURCE_VERSION
}

app.use("*", requestCorrelationMiddleware)

const CREDENTIAL_BEARING_REQUEST_HEADERS = [
  "authorization",
  "x-admin-token",
  "x-agent-connection-token",
  "x-very-callback-secret",
  "x-karaoke-finalize-secret",
  "x-dance-grader-signature",
  "x-telegram-bot-secret",
  "x-telegram-bot-api-secret-token",
] as const

function hasCredentialBearingHeader(request: Request): boolean {
  return CREDENTIAL_BEARING_REQUEST_HEADERS.some((header) => request.headers.has(header))
}

app.use("*", async (c, next) => {
  if (
    !hasCredentialBearingHeader(c.req.raw)
    || isPublicReadCacheRequest(c.req.raw)
  ) {
    await next()
    return
  }

  // A credential-bearing response must never be reusable by another caller.
  // Explicit public-read routes are the only exception: their response
  // contract is authentication-invariant even when a client happens to send
  // an Authorization header. Apply this at the outer app boundary rather than
  // relying on every authenticated route to remember its own cache policy.
  try {
    await next()
  } finally {
    applyNoStore(c.res)
  }
})

export function buildVersionMetadata(
  env: Pick<
    Env,
    | "BUILD_GIT_REF"
    | "BUILD_GIT_SHA"
    | "BUILD_TIMESTAMP"
    | "BUILD_RELEASE_ID"
    | "BUILD_ID"
    | "BUILD_WEB_SHA"
    | "BUILD_API_SHA"
    | "BUILD_CORE_SHA"
    | "BUILD_SOURCE_STATE"
    | "BUILD_DEPLOY_REASON_SLUG"
    | "BUILD_HOTFIX_REASON_SLUG"
    | "BUILD_PATCH_SHA256"
  >,
  compiled: BuildVersionMetadata = COMPILED_BUILD_VERSION_METADATA,
): BuildVersionMetadata {
  const useCompiledSourceProvenance = compiled.source_state !== null

  return {
    git_ref: compiled.git_ref ?? env.BUILD_GIT_REF ?? null,
    git_sha: compiled.git_sha ?? env.BUILD_GIT_SHA ?? null,
    build_timestamp: compiled.build_timestamp ?? env.BUILD_TIMESTAMP ?? null,
    release_id: compiled.release_id ?? env.BUILD_RELEASE_ID ?? null,
    build_id: compiled.build_id ?? env.BUILD_ID ?? null,
    web_sha: compiled.web_sha ?? env.BUILD_WEB_SHA ?? null,
    api_sha: compiled.api_sha ?? env.BUILD_API_SHA ?? null,
    core_sha: compiled.core_sha ?? env.BUILD_CORE_SHA ?? null,
    source_state: useCompiledSourceProvenance
      ? compiled.source_state
      : env.BUILD_SOURCE_STATE ?? null,
    deploy_reason_slug: useCompiledSourceProvenance
      ? compiled.deploy_reason_slug
      : env.BUILD_DEPLOY_REASON_SLUG ?? null,
    hotfix_reason_slug: useCompiledSourceProvenance
      ? compiled.hotfix_reason_slug
      : env.BUILD_HOTFIX_REASON_SLUG ?? null,
    patch_sha256: useCompiledSourceProvenance
      ? compiled.patch_sha256
      : env.BUILD_PATCH_SHA256 ?? null,
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
    release_id: buildVersion.release_id,
    build_id: buildVersion.build_id,
    web_sha: buildVersion.web_sha,
    api_sha: buildVersion.api_sha ?? buildVersion.git_sha,
    core_sha: buildVersion.core_sha,
    source_state: buildVersion.source_state,
    deploy_reason_slug: buildVersion.deploy_reason_slug,
    hotfix: buildVersion.source_state === "dirty"
      ? {
          reason_slug: buildVersion.hotfix_reason_slug,
          patch_sha256: buildVersion.patch_sha256,
        }
      : null,
    karaoke_scoring_version: KARAOKE_SCORING_VERSION,
    karaoke_runtime: {
      version: KARAOKE_RUNTIME_BUILD.version,
      git_sha: KARAOKE_RUNTIME_BUILD.gitSha,
    },
    api_origin: env.PIRATE_API_PUBLIC_ORIGIN ?? null,
  }
}

function configuredCorsOrigin(
  origin: string,
  c: { env: Env; get(name: "hnsOriginAllowed"): boolean | undefined },
): string | null {
  return configuredCorsOriginForEnv(origin, c.env, Boolean(c.get("hnsOriginAllowed")))
}

function freshRoutingSnapshot(snapshot: HnsRootRoutingAuthoritySnapshot | null, nowMs: number): boolean {
  if (!snapshot) return false
  const updatedAt = Date.parse(snapshot.updatedAt)
  const ageMs = nowMs - updatedAt
  return Number.isFinite(updatedAt) && ageMs >= 0 && ageMs <= HNS_ROOT_ROUTING_AUTHORITY_TTL_MS
}

function routingSnapshotMatchesRoot(
  snapshot: HnsRootRoutingAuthoritySnapshot | null,
  rootLabel: string,
): boolean {
  return snapshot?.originHostname === `https://${rootLabel}`
}

function routingSnapshotFromRead(input: {
  rootLabel: string
  effective: boolean
  reasonCode: HnsRootRoutingAuthoritySnapshot["reasonCode"]
  now: Date
  current: HnsRootRoutingAuthoritySnapshot | null
}): HnsRootRoutingAuthoritySnapshot {
  return {
    authorityVersion: (input.current?.authorityVersion ?? 0) + 1,
    effective: input.effective,
    originHostname: `https://${input.rootLabel}`,
    reasonCode: input.reasonCode,
    updatedAt: input.now.toISOString(),
  }
}

async function resolveHnsOriginAllowed(origin: string | null, env: Env): Promise<boolean> {
  if (!origin) return false
  let hostname: string
  try {
    hostname = new URL(origin).hostname.toLowerCase()
  } catch {
    return false
  }
  // Canonical Pirate/Clawitzer hosts remain configured platform origins. They
  // are not imported sovereign roots and therefore do not consult HNS state.
  if (hostname.endsWith(".pirate") || hostname.endsWith(".clawitzer")) return false
  const rootLabel = importedHnsAppRoot(origin) ?? importedHnsRootLabel(origin)
  if (!rootLabel) return false
  const now = new Date()
  const nowMs = now.getTime()
  const stub = hnsWalletOriginAuthorityStub(env)
  try {
    const hasRoutingProjection = typeof stub?.readRoutingSnapshot === "function"
    const current = hasRoutingProjection
      ? await stub?.readRoutingSnapshot?.(rootLabel) ?? null
      : null
    if (routingSnapshotMatchesRoot(current, rootLabel) && freshRoutingSnapshot(current, nowMs)) {
      return current?.effective === true
    }

    // Compatibility for test doubles and an old authority binding during a
    // staged rollout. The current DO always exposes the routing methods, so
    // production requests never use wallet registration as root activation.
    if (!hasRoutingProjection && importedHnsAppRoot(origin)) {
      const walletSnapshot = await stub?.readSnapshot(rootLabel)
      if (
        walletSnapshot?.effective === true
        && walletSnapshot.originHostname === `app.${rootLabel}`
      ) {
        return true
      }
    }

    const authority = await readHnsRootRoutingAuthority(
      getControlPlaneClient(env),
      rootLabel,
      now,
    )
    const snapshot = routingSnapshotFromRead({
      rootLabel,
      effective: authority.effective,
      reasonCode: authority.reasonCode,
      now,
      current,
    })
    await stub?.applyRoutingSnapshot?.(snapshot)
    return authority.effective
  } catch (error) {
    console.error(JSON.stringify({
      event: "hns_root_routing_authority_read_failed",
      root_label: rootLabel,
      error: error instanceof Error ? error.message : String(error),
    }))
    return false
  }
}

// CORS authority refreshes can consult the request-scoped control-plane
// client. Keep this scope outside the resolver and the downstream route so a
// stale projection never causes an unbounded connection or a second scope.
app.use("*", async (_c, next) => {
  await withRequestControlPlaneClients(next)
})

app.use("/*", async (c, next) => {
  c.set(
    "hnsOriginAllowed",
    await resolveHnsOriginAllowed(c.req.header("origin") ?? null, c.env),
  )
  await next()
})

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
      exposeHeaders: [REQUEST_ID_HEADER],
    })(c, next)
  },
)

app.get("/health", (c) => c.json({ ok: true }))
app.get("/health/provisioning", async (c) => {
  let configuredShards: ReturnType<typeof listConfiguredCommunityShards>
  try {
    configuredShards = listConfiguredCommunityShards(c.env)
  } catch (error) {
    console.error(JSON.stringify({
      event: "community_d1_shard_registry_invalid",
      error: error instanceof Error ? error.message : String(error),
    }))
    return c.json(
      {
        ok: false,
        backend: "d1_native",
        environment: c.env.ENVIRONMENT ?? null,
        error_code: "d1_shard_registry_invalid",
      },
      503,
      { "cache-control": "no-store" },
    )
  }
  const healthShards = configuredShards.length > 0
    ? configuredShards
    : c.env.COMMUNITY_D1_SHARD
      ? [{ shardWorkerId: null, bindingName: "COMMUNITY_D1_SHARD", shard: c.env.COMMUNITY_D1_SHARD }]
      : []
  const shardConfigured = healthShards.length > 0
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

  let allocationShard: ReturnType<typeof resolveCommunityAllocationShard>
  try {
    allocationShard = resolveCommunityAllocationShard(c.env)
  } catch (error) {
    console.error(JSON.stringify({
      event: "community_d1_allocation_shard_invalid",
      error: error instanceof Error ? error.message : String(error),
    }))
    return c.json(
      {
        ok: false,
        backend: "d1_native",
        shard_configured: true,
        region_configured: true,
        admin_configured: true,
        environment: c.env.ENVIRONMENT ?? null,
        error_code: "d1_shard_registry_invalid",
      },
      503,
      { "cache-control": "no-store" },
    )
  }

  const expectedShardSourceVersion = expectedCommunityD1ShardSourceVersion(c.env)
  const shardVersions = await Promise.all(healthShards.map(async (target): Promise<{
    shardWorkerId: string | null
    version: ShardVersionInfo | null
  }> => {
    try {
      return { shardWorkerId: target.shardWorkerId, version: await target.shard.communityD1Version() }
    } catch (error) {
      console.error(JSON.stringify({
        event: "community_d1_shard_version_unavailable",
        shardWorkerId: target.shardWorkerId,
        error: error instanceof Error ? error.message : String(error),
        expectedShardSourceVersion,
      }))
      return { shardWorkerId: target.shardWorkerId, version: null }
    }
  }))
  let shardAttestationStatus: "verified" | "rpc_unavailable" | "expected_missing" | "actual_missing" =
    shardVersions.some((entry) => !entry.version) ? "rpc_unavailable" : "verified"

  const allocationShardVersion = shardVersions.find((entry) =>
    entry.shardWorkerId === allocationShard.shardWorkerId
  )?.version ?? null
  const mismatchedShard = shardVersions.find((entry) => {
    const actual = entry.version?.build.sourceVersion ?? null
    return expectedShardSourceVersion && actual && actual !== expectedShardSourceVersion
  })
  if (mismatchedShard) {
    console.error(JSON.stringify({
      event: "community_d1_shard_version_mismatch",
      expectedShardSourceVersion,
      shardWorkerId: mismatchedShard.shardWorkerId,
      actualShardSourceVersion: mismatchedShard.version?.build.sourceVersion ?? null,
      shardVersion: mismatchedShard.version,
    }))
    return c.json(
      {
        ok: false,
        backend: "d1_native",
        shard_configured: true,
        region_configured: true,
        admin_configured: true,
        environment: c.env.ENVIRONMENT ?? null,
        shard_version: allocationShardVersion,
        shard_versions: shardVersions,
        expected_shard_source_version: expectedShardSourceVersion,
        error_code: "d1_shard_version_mismatch",
      },
      503,
      { "cache-control": "no-store" },
    )
  }
  const actualShardSourceVersions = shardVersions.map((entry) => entry.version?.build.sourceVersion ?? null)
  if (shardAttestationStatus === "verified" && !expectedShardSourceVersion) {
    shardAttestationStatus = "expected_missing"
    console.error(JSON.stringify({
      event: "community_d1_shard_expected_version_missing",
      actualShardSourceVersions,
      shardVersions,
    }))
  } else if (shardAttestationStatus === "verified" && actualShardSourceVersions.some((version) => !version)) {
    shardAttestationStatus = "actual_missing"
    console.error(JSON.stringify({
      event: "community_d1_shard_actual_version_missing",
      expectedShardSourceVersion,
      shardVersions,
    }))
  }

  let observedPools: Awaited<ReturnType<typeof readD1PoolStats>>
  try {
    observedPools = await readD1PoolStats(c.env)
  } catch (error) {
    console.error(JSON.stringify({
      event: "community_d1_pool_stats_unavailable",
      error: error instanceof Error ? error.message : String(error),
    }))
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

  // Low capacity is a WARNING, not an outage. `classifyD1PoolCapacity` keeps its
  // meaning (healthy = free > threshold) because the capacity watchdog alerts on
  // `!healthy` — do not widen it here or low-capacity alerts go silent.
  //
  // Only genuine exhaustion breaks provisioning, so only exhaustion may fail this
  // probe. Deploy smokes gate on this endpoint, and a *warning* that blocks every
  // deploy is what kept web off production for a full day on 2026-07-13.
  // Allocation itself still fails loudly on its own path (`d1_pool_exhausted`
  // from the provisioning backend), so nothing is masked by reporting 200 here.
  const capacity = classifyD1PoolCapacity(
    observedPools.aggregate,
    c.env.COMMUNITY_D1_POOL_FREE_ALERT_THRESHOLD,
    c.env.COMMUNITY_D1_POOL_EXHAUSTION_ALERT_HOURS,
  )
  const allocationPool = observedPools.pools.find((pool) =>
    pool.shardWorkerId === allocationShard.shardWorkerId
  )
  if (!allocationPool) {
    return c.json(
      {
        ok: false,
        backend: "d1_native",
        environment: c.env.ENVIRONMENT ?? null,
        error_code: "d1_allocation_pool_stats_missing",
      },
      503,
      { "cache-control": "no-store" },
    )
  }
  const allocationCapacity = classifyD1PoolCapacity(
    allocationPool.stats,
    c.env.COMMUNITY_D1_POOL_FREE_ALERT_THRESHOLD,
    c.env.COMMUNITY_D1_POOL_EXHAUSTION_ALERT_HOURS,
  )
  const exhausted = allocationCapacity.free <= 0
  const degradedReasons = [
    ...(!allocationCapacity.healthy && !exhausted ? ["d1_pool_low_capacity"] : []),
    ...(shardAttestationStatus !== "verified"
      ? [`d1_shard_attestation_${shardAttestationStatus}`]
      : []),
  ]
  const degraded = degradedReasons.length > 0
  return c.json(
    {
      ok: !exhausted,
      backend: "d1_native",
      shard_configured: true,
      region_configured: true,
      admin_configured: true,
      environment: c.env.ENVIRONMENT ?? null,
      shard_version: allocationShardVersion,
      shard_versions: shardVersions,
      expected_shard_source_version: expectedShardSourceVersion,
      shard_attestation: {
        healthy: shardAttestationStatus === "verified",
        status: shardAttestationStatus,
      },
      pool_capacity: capacity,
      pool_capacities: observedPools.pools,
      allocation_shard_worker_id: allocationShard.shardWorkerId,
      allocation_pool_capacity: allocationCapacity,
      ...(degraded
        ? {
          degraded: true,
          degraded_reason: degradedReasons[0],
          degraded_reasons: degradedReasons,
        }
        : {}),
      ...(exhausted ? { error_code: "d1_pool_exhausted" } : {}),
    },
    exhausted ? 503 : 200,
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
app.route("/dance-choreographies", danceChoreographies)
app.route("/dance-sessions", danceSessions)
app.route("/dance-attempts", danceAttempts)
app.route("/posts", postDanceChoreographies)
/** Operational responses are never cacheable — including error responses. */
function applyNoStore(response: Response | undefined): void {
  if (!response) return
  try {
    response.headers.delete("cloudflare-cdn-cache-control")
    response.headers.delete("cdn-cache-control")
    response.headers.delete("cache-tag")
    response.headers.set("cache-control", "private, no-store, max-age=0, must-revalidate")
    response.headers.set("pragma", "no-cache")
  } catch {
    // Immutable headers on some synthetic responses; the onError path below
    // rebuilds those and applies the same directives.
  }
}

app.use("/admin/*", async (c, next) => {
  // try/finally, and a direct write to the final response headers, because
  // c.header() alone does NOT survive a THROWN error: the error propagates past
  // await next() and the error handler builds a fresh Response. That gap was
  // real — /admin/debug/post-pipeline returned 400 with no cache-control.
  try {
    await next()
  } finally {
    applyNoStore(c.res)
  }
})
app.use("/operator/*", async (c, next) => {
  try {
    await next()
  } finally {
    applyNoStore(c.res)
  }
})
app.route("/admin/bot-users", botUsers)
app.route("/admin/debug", debugPipeline)
// Operational state must never be served from a cache. These endpoints report
// live state an operator acts on — which deliveries are stranded, which wallets
// are underfunded — and a replayed response is worse than no response: it shows
// work that is already done, or hides work that just appeared.
//
// Observed on staging: the unfiltered uncertain-delivery count returned a
// 19-minute-old body (cf-cache-status HIT, age 1164) reporting a stranded
// delivery that had already been resolved. Filtered URLs looked correct only
// because they were different cache keys that had not been populated yet.
//
// `no-store` is set BEFORE the handler runs and on every response, including
// errors, so nothing downstream has to remember to opt out.
//
// Scoped to the ENTIRE /admin namespace, not just /admin/ops. Auditing the
// mounts found /admin/debug/post-pipeline and
// /admin/debug/story-registration-effect: admin-authenticated GETs with no
// cache-control, i.e. the same shape that leaked. All four /admin mounts
// (bot-users, debug, ops, ops/telegram) are admin-gated and none is public, so
// nothing here is safely cacheable and a future admin route is covered by
// default rather than by remembering.

app.route("/admin/ops", opsWallets)
app.route("/admin/ops/telegram", opsTelegramDeliveries)
app.route("/internal/hns-edge-alerts", hnsEdgeAlerts)
app.route("/community-media", communityMedia)
app.route("/comments", comments)
app.route("/communities", communities)
app.route("/", publicReadApp)
app.route("/geo", geo)
app.route("/gate-capabilities", gateCapabilities)
app.route("/jobs", jobs)
app.route("/karaoke/sessions", karaokeSessions)
app.route("/mcp", mcp)
app.route("/notifications", notifications)
app.route("/oauth", oauth)
app.route("/royalties", royalties)
app.route("/operator/story-settlement", storySettlementOps)
app.route("/operator/content-security", contentSecurityOps)
app.route("/admin/ops/hns-wallet-origins", hnsWalletOriginOps)
app.route("/posts", posts)
app.route("/public-agents", publicAgents)
app.route("/public-names", publicNames)
app.route("/public-namespaces", publicNamespaces)
app.route("/public-profiles", publicProfiles)
app.route("/profile-media", profileMedia)
app.route("/users", users)
app.route("/onboarding", onboarding)
app.route("/profiles", profiles)
app.route("/api/privy-relay", privyRelay)
app.route("/", rewards)
app.route("/host-bookings", hostBookings)
app.route("/telegram", telegram)
app.route("/wallet-identities", walletIdentities)
app.route("/", verification)

app.post("/__debug/ops-alert", async (c) => {
  if (c.env.ENVIRONMENT === "production") {
    return c.json({ error: "not_found" }, 404)
  }
  const admin = await authenticateAdminAccessOnly({
    env: c.env,
    authorization: c.req.header("authorization"),
    legacyToken: c.req.header("x-admin-token"),
    requiredScope: ADMIN_DEBUG_ACCESS_SCOPE,
  })
  if (!admin) {
    return c.json({ error: "unauthorized" }, 401)
  }
  const delivered = await captureScheduledWarning(
    c.env,
    "Ops alert smoke test",
    "ops_alert_smoke_test",
    { source: "__debug/ops-alert" },
    { urgency: "high" },
  )
  if (!delivered) {
    return c.json({ ok: false, error: "ops_alert_delivery_failed" }, 503)
  }
  return c.json({ ok: true })
})

app.notFound((c) => c.json({ code: "not_found", message: "Not found" }, 404))

app.onError(async (error, c) => {
  const response = await apiErrorHandler(error, c)
  // A thrown error inside /admin or on any credential-bearing request must not
  // become a cacheable body either.
  if (
    new URL(c.req.url).pathname.startsWith("/admin/")
    || new URL(c.req.url).pathname.startsWith("/operator/")
    || hasCredentialBearingHeader(c.req.raw)
  ) {
    applyNoStore(response)
  }
  return response
})

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

function appendCommaSeparatedHeader(headers: Headers, name: string, value: string): void {
  const existing = (headers.get(name) ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  if (!existing.some((item) => item.toLowerCase() === value.toLowerCase())) {
    headers.set(name, [...existing, value].join(", "))
  }
}

async function applyCorsHeaders(
  request: Request,
  response: Response,
  env: Env,
  hnsOriginAllowed: boolean,
): Promise<Response> {
  if (response.headers.has("Access-Control-Allow-Origin")) {
    if ((response.headers.get("Access-Control-Expose-Headers") ?? "")
      .split(",")
      .some((value) => value.trim().toLowerCase() === REQUEST_ID_HEADER)) {
      return response
    }
    const next = new Response(response.body, response)
    appendCommaSeparatedHeader(next.headers, "Access-Control-Expose-Headers", REQUEST_ID_HEADER)
    return next
  }

  const origin = request.headers.get("Origin")
  if (!origin) {
    return response
  }

  const allowedOrigin = configuredCorsOriginForEnv(
    origin,
    env,
    hnsOriginAllowed,
  )
  if (!allowedOrigin) {
    return response
  }

  const next = new Response(response.body, response)
  next.headers.set("Access-Control-Allow-Origin", allowedOrigin)
  appendCommaSeparatedHeader(next.headers, "Access-Control-Expose-Headers", REQUEST_ID_HEADER)
  appendVaryHeader(next.headers, "Origin")
  return next
}

async function fetchApi(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  return await withRequestControlPlaneClients(async () => {
    const hnsOriginAllowed = await resolveHnsOriginAllowed(req.headers.get("Origin"), env)
    const response = isPublicReadCacheRequest(req)
      ? await fetchPublicRead(req, env, ctx)
      : await app.fetch(req, env, ctx)
    // Rehost stored absolute media refs to the allowlisted HNS request host
    // after the (potentially cache-fronted) inner fetch, so cached and stored
    // payloads always keep the canonical origin.
    const mirrored = await mirrorResponseToRequestHost({ request: req, response, env })
    return await applyCorsHeaders(req, mirrored, env, hnsOriginAllowed)
  })
}

async function flushScheduledAnalytics(env: Env): Promise<void> {
  const db = getControlPlaneClient(env)
  try {
    try {
      await pruneAnalyticsOutbox(db)
    } catch (error) {
      console.error("[analytics] scheduled prune failed", error)
      try {
        await captureScheduledError(env, error, "analytics_prune")
      } catch (captureError) {
        console.error("[analytics] scheduled prune error capture failed", captureError)
      }
    }

    if (!isAnalyticsEnabled(env)) {
      return
    }

    try {
      await flushAnalyticsOutbox(env, db)
    } catch (error) {
      console.error("[analytics] scheduled flush failed", error)
      await captureScheduledError(env, error, "analytics_flush")
    }
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
    if (summary.projection_reset || summary.processed_days > 0) {
      console.info("[analytics] synced community health counts", JSON.stringify(summary))
    }
  } catch (error) {
    console.error("[analytics] scheduled community health sync failed", error)
    if (isCommunityHealthSyncSaturationError(error)) {
      await captureScheduledWarning(
        env,
        "Community health analytics sync reached its daily row limit and requires operator action",
        "community_health_sync_saturated",
        { date: error.date, row_limit: error.rowLimit },
        { urgency: "high" },
      )
    } else {
      await captureScheduledError(env, error, "community_health_sync")
    }
  } finally {
    db.close?.()
  }
}

async function scanScheduledEfpChain(
  env: Env,
  config: EfpIndexerChainConfig,
  rpcUrlValue: string | undefined,
): Promise<void> {
  const rpcUrl = String(rpcUrlValue ?? "").trim()
  if (!rpcUrl) return
  const summary = await scanEfpChainOnce({
    client: getControlPlaneClient(env),
    rpcUrl,
    config,
  })
  console.info(JSON.stringify({
    component: "efp_indexer",
    operation: `scan_${config.name}`,
    ...summary,
  }))
}

async function reconcileScheduledEfpFollowWrites(env: Env): Promise<void> {
  const sponsorship = await reconcilePendingPrivyFollowSubmissions({
    client: getControlPlaneClient(env),
    env,
    limit: 100,
  })
  const summary = await reconcilePendingFollowWrites({
    client: getControlPlaneClient(env),
    limit: 100,
  })
  const adoptionSnapshotStartedAtMs = Date.now()
  const adoptionSnapshot = await recordEfpFollowAdoptionSnapshot({ client: getControlPlaneClient(env) })
  console.info(JSON.stringify({
    component: "efp_follow_writes",
    operation: "adoption_snapshot",
    recorded: adoptionSnapshot.recorded,
    duration_ms: Date.now() - adoptionSnapshotStartedAtMs,
  }))
  if (adoptionSnapshot.recorded && new Date().getUTCDay() === 1) {
    const weekly = await readEfpFollowWeeklyAdoptionReport({ client: getControlPlaneClient(env) })
    if (weekly) {
      console.info(JSON.stringify({
        component: "efp_follow_writes",
        operation: "weekly_adoption_report",
        ...weekly,
      }))
    }
  }
  if (summary.examined > 0 || sponsorship.examined > 0) {
    console.info(JSON.stringify({
      component: "efp_follow_writes",
      operation: "reconcile_projection",
      sponsorship,
      ...summary,
    }))
  }
}

async function reconcileScheduledContentBlobs(env: Env): Promise<void> {
  const summary = await expireUnclaimedContentBlobs({
    client: getControlPlaneClient(env),
    now: new Date().toISOString(),
    limit: 100,
  })
  if (summary.contentBlobIds.length > 0) {
    console.info("[scheduled] expired unclaimed content blobs", JSON.stringify({
      count: summary.contentBlobIds.length,
      content_blob_ids: summary.contentBlobIds,
    }))
  }
}

async function reconcileScheduledGenericAssetPayloads(env: Env): Promise<void> {
  if (env.GENERIC_DIGITAL_GOODS_ENABLED !== "true") return
  const repository = getCommunityRepository(env)
  const payloadSummary = await reconcileGenericAssetPayloads({
    env,
    repository,
    communityLimit: 25,
    payloadLimitPerCommunity: 100,
  })
  const retentionSummary = await reconcileDeckImportPlaintextRetention({
    env,
    repository,
  })
  if (retentionSummary.purged > 0 || retentionSummary.errors > 0) {
    console.info("[scheduled] deck import plaintext retention reconciled", {
      payload_summary: payloadSummary,
      retention_summary: retentionSummary,
    })
  }
}

async function processScheduledCommunityJobs(env: Env): Promise<void> {
  const communityRepository = getCommunityRepository(env)
  const taskStartedAtMs = Date.now()
  const taskDeadlineAtMs = taskStartedAtMs + COMMUNITY_JOB_TASK_DEADLINE_MS
  const preludeDeadlineAtMs = Math.min(
    taskStartedAtMs + COMMUNITY_JOB_PRELUDE_DEADLINE_MS,
    taskDeadlineAtMs,
  )
  try {
    let priorityCommunityIds: string[] = []
    try {
      priorityCommunityIds = await listActiveTelegramChannelCommunityIds({
        client: getControlPlaneClient(env),
        limit: 25,
      })
    } catch (error) {
      console.warn(
        "[community-jobs] failed to load Telegram channel priority hints",
        error,
      )
    }
    const reconciledLockedDelivery = await reconcileRequestedLockedAssetDeliveryJobs({
      env,
      communityRepository,
      maxCommunities: 100,
      maxAssetsPerCommunity: 25,
      deadlineAtMs: preludeDeadlineAtMs,
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
      deadlineAtMs: preludeDeadlineAtMs,
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
    const summary = await processAvailableCommunityJobs({
      env,
      communityRepository,
      maxCommunities: 100,
      maxJobsPerCommunity: 25,
      priorityCommunityIds,
      skipJobTypes: ["post_publish_finalize"],
      // Clamp the drain's tick to the task deadline; the prelude sub-budget
      // normally leaves the full 45s, but an overrun must not push the task
      // past the scheduler lease.
      deadlineMs: Math.max(1, Math.min(COMMUNITY_JOB_TICK_DEADLINE_MS, taskDeadlineAtMs - Date.now())),
      sweepDeadlineMs: COMMUNITY_JOB_STALE_SWEEP_DEADLINE_MS,
    })
    if (
      summary.processed_jobs > 0
      || summary.failed_communities.length > 0
      || summary.deferred_communities > 0
      || summary.deferred_sweep_communities > 0
    ) {
      console.info("[community-jobs] scheduled processed", JSON.stringify({
        failed_communities: summary.failed_communities.length,
        processed_jobs: summary.processed_jobs,
        swept_communities: summary.swept_communities,
        deferred_sweep_communities: summary.deferred_sweep_communities,
        started_communities: summary.started_communities,
        deferred_communities: summary.deferred_communities,
        sweep_ms: summary.sweep_ms,
        process_ms: summary.process_ms,
        communities: summary.communities.map((community) => ({
          community_id: community.community_id,
          processed_jobs: community.processed_jobs,
        })),
      }))
    }
    // Jobs that burned their final attempt this tick are abandoned permanently —
    // no retry follows and the subject silently stays unfinished. Aggregated to
    // one alert per tick so ordinary retry churn stays quiet.
    const exhausted = exhaustedCommunityJobs(summary)
    if (exhausted.length > 0) {
      // Capped: a bad tick can exhaust jobs across many communities, and the
      // console line should stay bounded. Messages are already redacted upstream.
      console.error("[community-jobs] jobs exhausted all attempts", JSON.stringify({
        exhausted_jobs: exhausted.length,
        jobs: exhausted.slice(0, 20),
      }))
      await captureScheduledWarning(
        env,
        "Community jobs exhausted all retry attempts and were abandoned",
        "community_jobs_attempt_exhaustion",
        {
          exhausted_jobs: exhausted.length,
          job_types: [...new Set(exhausted.map((job) => job.job_type))],
          jobs: exhausted.slice(0, 20),
        },
        { urgency: exhausted.length > 5 ? "high" : "low" },
      )
    }
    const opsAlerts = await runOpsAlerts({
      env,
      communityRepository,
      nowMs: Date.now(),
      deadlineAtMs: taskDeadlineAtMs,
    })
    // Always logged: the staging soak measures each phase from this line rather
    // than inferring the prelude from the task total.
    console.info("[community-jobs] scheduled task timing", JSON.stringify({
      task_ms: Date.now() - taskStartedAtMs,
      task_deadline_ms: COMMUNITY_JOB_TASK_DEADLINE_MS,
      locked_delivery_reconcile_ms: reconciledLockedDelivery.reconcile_ms,
      locked_delivery_checked_communities: reconciledLockedDelivery.checked_communities,
      locked_delivery_deferred_communities: reconciledLockedDelivery.deferred_communities,
      song_artifact_session_reconcile_ms: reconciledUploadSessions.reconcile_ms,
      song_artifact_session_checked_communities: reconciledUploadSessions.checked_communities,
      song_artifact_session_deferred_communities: reconciledUploadSessions.deferred_communities,
      sweep_ms: summary.sweep_ms,
      process_ms: summary.process_ms,
      ops_alerts_scan_ms: opsAlerts.scan_ms,
      ops_alerts_scanned_communities: opsAlerts.scanned_communities,
      ops_alerts_deferred_communities: opsAlerts.deferred_communities,
    }))
  } catch (error) {
    console.error("[community-jobs] scheduled processing failed", error)
    await captureScheduledError(env, error, "community_jobs")
  } finally {
    await communityRepository.close?.()
  }
}

async function processScheduledPostPublishFinalizeJobs(env: Env): Promise<void> {
  const communityRepository = getCommunityRepository(env)
  const taskStartedAtMs = Date.now()
  const taskDeadlineAtMs = taskStartedAtMs + COMMUNITY_PUBLISH_TASK_DEADLINE_MS
  try {
    const reconciled = await reconcileStuckPostPublishFinalizeJobs({
      env,
      communityRepository,
      maxCommunities: 100,
      maxPostsPerCommunity: 25,
      deadlineAtMs: Math.min(
        taskDeadlineAtMs,
        taskStartedAtMs + COMMUNITY_PUBLISH_RECONCILE_DEADLINE_MS,
      ),
    })
    if (reconciled.failed_posts > 0 || reconciled.failed_communities.length > 0) {
      console.info("[community-publish] reconciled stuck post publish finalize jobs", JSON.stringify(reconciled))
      await captureScheduledWarning(
        env,
        reconciled.failed_posts > 0
          ? "Post publish finalize reconciliation marked stuck posts failed"
          : "Post publish finalize reconciliation had community routing failures",
        "community_jobs_post_publish_finalize_reconciliation",
        reconciled,
        {
          urgency: reconciled.failed_posts > 5
            ? "high"
            : reconciled.failed_posts > 0
              ? "medium"
              : "low",
        },
      )
    }
    const summary = await processAvailableCommunityJobs({
      env,
      communityRepository,
      maxCommunities: 100,
      maxJobsPerCommunity: 10,
      onlyJobTypes: ["post_publish_finalize"],
      deadlineMs: Math.max(1, taskDeadlineAtMs - Date.now()),
      skipStaleSweep: true,
    })
    if (summary.processed_jobs > 0 || summary.failed_communities.length > 0 || summary.deferred_communities > 0) {
      console.info("[community-publish] scheduled processed", JSON.stringify({
        processed_jobs: summary.processed_jobs,
        failed_communities: summary.failed_communities.length,
        started_communities: summary.started_communities,
        deferred_communities: summary.deferred_communities,
        process_ms: summary.process_ms,
      }))
    }
  } catch (error) {
    console.error("[community-publish] scheduled processing failed", error)
    await captureScheduledError(env, error, "community_publish_finalize")
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
    if (summary.checked > 0 || summary.projection_synced > 0 || summary.failed > 0 || summary.failed_communities.length > 0) {
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
    if (summary.stillPending > 0 || summary.failed > 0 || summary.errors > 0) {
      await captureScheduledWarning(
        env,
        "Paid purchase settlements require attention",
        "purchase_settlement_stalled",
        {
          count: summary.stillPending + summary.failed + summary.errors,
          ...summary,
          communities: summary.stalledCommunityIds.map((communityId) => ({ community_id: communityId })),
        },
        { urgency: "high" },
      )
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
  try {
    globalSummary = await sweepGlobalBookingSettlements({ env, client: getControlPlaneClient(env), maxBookings: 100, deadlineMs: 20_000 })
    // Sweep classifies enumeration failures fatal without surfacing the raw error; alert on it with a
    // generic marker (no raw message/object reaches alert sinks from coordinator/RPC paths).
    if (globalSummary.fatal) await captureScheduledError(env, new Error("global_booking_settlement_sweep_fatal"), "global_booking_settlement_reconciliation")
  } catch (error) {
    // Defense: an unexpected throw past the sweep still yields a fatal summary (no raw error logged).
    globalSummary.errors += 1
    globalSummary.fatal = true
    await captureScheduledError(env, error, "booking_settlement_reconciliation")
  } finally {
    // One structured summary for EVERY enabled run — including zero-work AND fatal runs.
    console.info("[global-booking-settlements] swept", JSON.stringify(globalSummary))
  }
}

async function reverifyScheduledBookingPayments(env: Env): Promise<void> {
  // Hold expiry is lifecycle hygiene, not money movement. Run it on every scheduled
  // invocation even when payment re-verification is disabled, so hold rows cannot
  // remain `active` forever merely because an independent payment gate is off.
  try {
    const expired = await createBookingHoldWriteRepository(getControlPlaneClient(env))
      .expireDueHolds(new Date().toISOString())
    if (expired.length > 0) {
      console.info("[booking-holds] expired due holds", JSON.stringify({ expired: expired.length }))
    }
  } catch (error) {
    await captureScheduledError(env, error, "booking_hold_expiry")
  }
  if (!isBookingPaymentReverificationCronEnabled(env)) return
  let summary = emptyBookingPaymentReverificationSummary(true)
  try {
    summary = await sweepClaimedBookingPaymentIntents({
      env,
      client: getControlPlaneClient(env),
      userRepository: getUserRepository(env),
      maxIntents: 100,
      deadlineMs: 20_000,
    })
    if (summary.fatal) {
      await captureScheduledError(env, new Error("booking_payment_reverification_sweep_fatal"), "booking_payment_reverification")
    } else if (summary.stale > 0 || summary.errors > 0 || summary.deadlineReached) {
      await captureScheduledWarning(
        env,
        "Claimed booking payments remain unresolved",
        "booking_payment_reverification",
        {
          stale: summary.stale,
          errors: summary.errors,
          unresolved: summary.unresolved,
          deadlineReached: summary.deadlineReached,
        },
      )
    }
  } catch (error) {
    summary.errors += 1
    summary.fatal = true
    await captureScheduledError(env, error, "booking_payment_reverification")
  } finally {
    console.info("[booking-payment-reverification] swept", JSON.stringify(summary))
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
        || summary.capacityDeferred > 0
        || summary.capacityObservationStale
        || summary.overdueSongs > 0
      )
    ) {
      console.info("[rewards] reconciled submitted reward payouts", JSON.stringify(summary))
    }
  } catch (error) {
    console.error("[rewards] payout reconciliation failed", error)
    await captureScheduledError(env, error, "reward_payout_reconciliation")
  }
}

async function enforceScheduledRewardNationalityRetention(env: Env): Promise<void> {
  const now = new Date().toISOString()
  try {
    const summary = await enforceRewardNationalityDecisionRetention({
      client: getControlPlaneClient(env),
      now,
    })
    if (summary.deleted > 0 || summary.overdue > 0) {
      console.info("[reward-nationality] retention", JSON.stringify(summary))
    }
    if (summary.overdue > 0) {
      await captureScheduledWarning(
        env,
        "Reward nationality decisions remain past their retention deadline",
        "reward_nationality_retention_overdue",
        summary,
        { urgency: "high" },
      )
    }
  } catch (error) {
    console.error("[reward-nationality] retention failed", error)
    await captureScheduledError(env, error, "reward_nationality_retention")
  }
}

async function monitorScheduledRewardCampaignTreasurySolvency(env: Env): Promise<void> {
  try {
    const client = getControlPlaneClient(env)
    const solvency = await monitorRewardCampaignTreasurySolvency({ env, client })
    if (solvency.configured) {
      console.info("[reward-campaigns] treasury solvency", JSON.stringify({
        treasury_address: solvency.treasuryAddress,
        chain_id: solvency.chainId,
        balance_atomic: solvency.balanceAtomic?.toString(),
        liability_atomic: solvency.liability?.totalAtomic.toString(),
        solvent: solvency.solvent,
        vault_capacity: solvency.vaultCapacity
          ? {
            policy_version: solvency.vaultCapacity.policyVersion.toString(),
            current_epoch: solvency.vaultCapacity.currentEpoch.toString(),
            payout_remaining_atomic: (
              solvency.vaultCapacity.payoutEpochCapAtomic - solvency.vaultCapacity.payoutSpentAtomic
            ).toString(),
            refund_remaining_atomic: (
              solvency.vaultCapacity.refundEpochCapAtomic - solvency.vaultCapacity.refundSpentAtomic
            ).toString(),
            observed_block_number: solvency.vaultCapacity.observedBlockNumber,
            observed_block_hash: solvency.vaultCapacity.observedBlockHash,
          }
          : undefined,
      }))
    }
  } catch (error) {
    console.error("[reward-campaigns] treasury solvency monitor failed", error)
    await captureScheduledError(env, error, "reward_campaign_treasury_solvency_monitor")
  }
}

async function reconcileScheduledSongArtifactHeadVerifications(env: Env): Promise<void> {
  try {
    const summary = await reconcileHeadVerifyingSongArtifactUploads({ env })
    if (summary.scanned > 0) {
      console.info("[song-artifacts] head verification", JSON.stringify(summary))
    }
  } catch (error) {
    console.error("[song-artifacts] head verification failed", error)
    await captureScheduledError(env, error, "song_artifact_head_verification")
  }
}

async function monitorScheduledRewardCampaigns(env: Env): Promise<void> {
  try {
    const client = getControlPlaneClient(env)
    const summary = await runRewardCampaignMonitorCycle({
      reconcileFunding: async () => {
        const funding = await reconcileConfirmingRewardCampaignFunding({
          env,
          client,
          limit: 100,
        })
        if (funding.errors > 0) {
          await captureScheduledWarning(
            env,
            "Submitted reward funding could not be reconciled",
            "reward_campaign_funding_confirmation_reconciliation",
            {
              errors: funding.errors,
              scanned: funding.scanned,
              pending: funding.pending,
            },
            { urgency: "high" },
          )
        }
      },
      onFundingError: async (error) => {
        console.error("[reward-campaigns] funding confirmation reconciliation failed", error)
        await captureScheduledError(env, error, "reward_campaign_funding_confirmation_reconciliation")
      },
      monitorIntegrity: () => monitorRewardCampaigns({ env, client, limit: 100 }),
    })
    if (!summary.enabled) return
    if (summary.liveness_stale) {
      await captureScheduledWarning(
        env,
        "Reward campaign integrity monitor liveness was stale",
        "reward_campaign_integrity_liveness",
        { errors: 1 },
        { urgency: "high" },
      )
    }
    if (summary.coverage_stale) {
      await captureScheduledWarning(
        env,
        "Reward campaign integrity monitor has not achieved complete finality coverage",
        "reward_campaign_integrity_coverage",
        {
          errors: summary.transient_finality_checks,
          finality_checks_attempted: summary.finality_checks_attempted,
        },
        { urgency: "high" },
      )
    }
    if (summary.wholly_blind) {
      await captureScheduledWarning(
        env,
        "Reward campaign integrity scan was wholly blind to funding finality",
        "reward_campaign_integrity_wholly_blind",
        {
          errors: summary.transient_finality_checks,
          finality_checks_attempted: summary.finality_checks_attempted,
        },
        { urgency: "high" },
      )
    } else if (summary.partial_finality_degraded) {
      await captureScheduledWarning(
        env,
        "Reward campaign integrity scan had a degraded finality provider",
        "reward_campaign_integrity_partial_finality",
        {
          errors: summary.transient_finality_checks,
          finality_checks_attempted: summary.finality_checks_attempted,
          transient_finality_rate: summary.transient_finality_rate,
        },
      )
    }
    if (summary.incidents.length > 0) {
      console.warn("[reward-campaigns] integrity incidents", JSON.stringify(summary))
      for (const incident of summary.incidents) {
        const delivered = await captureScheduledWarning(
          env,
          "Reward campaign integrity incident",
          `reward_campaign_integrity:${incident.incident_id}`,
          {
            incident_id: incident.incident_id,
            campaign_id: incident.campaign_id,
            incident_kind: incident.kind,
            reason: incident.reason,
            ...incident.details,
          },
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

export async function reconcileScheduledRewardCampaigns(env: Env): Promise<void> {
  const communityRepository = getCommunityRepository(env)
  try {
    const namespace = env.SCHEDULED_CRON_LOCK as DurableObjectNamespace<ScheduledCronLockDO> | undefined
    if (!namespace) throw new Error("SCHEDULED_CRON_LOCK binding is required for reward reconciliation")
    const locked = await runWithRewardReconciliationLock({
      namespace,
      run: (lease) => reconcileRewardCampaigns({
        env,
        communityRepository,
        controlPlaneClient: getControlPlaneClient(env),
        maxCommunities: 50,
        maxCredits: 500,
        outboxBatchSize: 500,
        shouldContinue: lease.isValid,
      }),
    })
    if (!locked.acquired) {
      console.info("[reward-campaigns] reconciler lease held; cron will retry on the next tick")
      return
    }
    const summary = locked.value
    if (locked.leaseLost) {
      console.error("[reward-campaigns] reconciler lease was lost before cron reconciliation completed")
    }
    if (summary.retirement_policy_anomalies > 0) {
      console.error("[reward-campaigns] funding effects created after retirement cutoff", JSON.stringify(summary))
    }
    if (summary.enabled && (
      summary.scanned_communities > 0
      || summary.ingested_qualifications > 0
      || summary.credited_events > 0
      || summary.pending_verification > 0
      || summary.expired_pending > 0
      || summary.canceled_retired_funding_campaigns > 0
      || summary.retirement_policy_anomalies > 0
      || summary.skipped_budget > 0
      || summary.deferred_funding > 0
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

async function reconcileScheduledRewardFundingRefunds(env: Env): Promise<void> {
  try {
    const summary = await reconcileRewardFundingRefunds({
      env,
      client: getControlPlaneClient(env),
      limit: 25,
    })
    if (summary.enabled && (summary.scanned > 0 || summary.errors > 0 || summary.rejected_finality > 0)) {
      console.info("[reward-funding-refunds] reconciled", JSON.stringify(summary))
    }
    if (summary.errors > 0 || summary.rejected_finality > 0) {
      await captureScheduledWarning(
        env,
        "Reward funding refunds require operator attention",
        "reward_funding_refund_reconciliation",
        summary,
        { urgency: "high" },
      )
    }
  } catch (error) {
    console.error("[reward-funding-refunds] reconciliation failed", error)
    await captureScheduledError(env, error, "reward_funding_refund_reconciliation")
  }
}

async function reconcileScheduledHandleClaims(env: Env): Promise<void> {
  const communityRepository = getCommunityRepository(env)
  try {
    const finalization = await reconcileFundedHandleClaimIntents({
      env,
      limit: 25,
      finalize: async (candidate) => {
        const database = await openCommunityWriteClient(env, communityRepository, candidate.communityId)
        try {
          const now = new Date().toISOString()
          const handle = await finalizeFundedHandleClaimOnShard({
            client: database.client,
            finalization: candidate,
            now,
            reservationHoldUntil: new Date(
              Date.parse(now) + resolveFundedHandleReservationSeconds(env) * 1000,
            ).toISOString(),
          })
          return { kind: "completed", handleId: finalizedHandleId(handle) }
        } catch (error) {
          return classifyHandleClaimFinalizationError(error)
        } finally {
          database.close()
        }
      },
    })
    const refunds = await reconcileHandleClaimRefunds({ env, limit: 25 })
    if (
      finalization.scanned > 0 || finalization.errors > 0
      || refunds.queued > 0 || refunds.errors > 0 || refunds.rejected_finality > 0
      || refunds.custody_mismatch > 0
      || refunds.operator_attention > 0
    ) {
      console.info("[handle-claim-recovery] reconciled", JSON.stringify({ finalization, refunds }))
    }
    if (!refunds.enabled && refunds.queued > 0) {
      await captureScheduledWarning(
        env,
        "Handle claim refunds are queued while automatic refunds are disabled",
        "handle_claim_refunds_disabled_backlog",
        refunds,
        { urgency: "high" },
      )
    }
    if (
      finalization.errors > 0 || finalization.retryable > 0 || refunds.errors > 0
      || refunds.rejected_finality > 0 || refunds.custody_mismatch > 0
      || refunds.operator_attention > 0
    ) {
      await captureScheduledWarning(
        env,
        "Funded handle claims require operator attention",
        "handle_claim_reconciliation",
        { finalization, refunds },
        { urgency: "high" },
      )
    }
  } catch (error) {
    console.error("[handle-claim-recovery] reconciliation failed", error)
    await captureScheduledError(env, error, "handle_claim_reconciliation")
  } finally {
    await communityRepository.close?.()
  }
}

async function revalidateScheduledHnsNamespaces(env: Env): Promise<void> {
  try {
    const summary = await sweepHnsNamespaceRevalidations({
      client: getControlPlaneClient(env),
      env,
    })
    if (summary.candidates > 0 || summary.errors > 0) {
      console.info("[hns-revalidation] swept", JSON.stringify(summary))
    }
    const alertState = hnsNamespaceRevalidationAlertState(summary)
    if (alertState.allDeferred || alertState.massDeferred) {
      console.warn("[hns-revalidation] observations deferred", JSON.stringify({
        ...summary,
        alert: alertState.allDeferred ? "all_deferred" : "mass_deferred",
      }))
      await captureScheduledWarning(
        env,
        "HNS namespace revalidation observations were broadly deferred",
        "hns_namespace_revalidation_deferred",
        { ...summary, count: summary.deferred },
        { urgency: "high" },
      )
    }
    if (alertState.leaseExpiryRisk) {
      console.warn("[hns-revalidation] ownership leases approaching expiry", JSON.stringify(summary))
      await captureScheduledWarning(
        env,
        "HNS namespace ownership leases are approaching expiry without refresh",
        "hns_namespace_revalidation_lease_expiry",
        { ...summary, count: summary.leasesApproachingExpiry },
        { urgency: "high" },
      )
    }
    if (summary.errors > 0) {
      await captureScheduledWarning(
        env,
        "HNS namespace revalidation completed with write errors",
        "hns_namespace_revalidation",
        summary,
        { urgency: "high" },
      )
    }
  } catch (error) {
    console.error("[hns-revalidation] sweep failed", error)
    await captureScheduledError(env, error, "hns_namespace_revalidation")
  }
}

async function observeScheduledHnsRoots(env: Env): Promise<void> {
  try {
    const summary = await observeDueHnsRoots(getControlPlaneClient(env), env)
    if (summary.attempted > 0) {
      console.info("[hns-root-observer] observed", JSON.stringify(summary))
    }
    if (summary.failed > 0) {
      await captureScheduledWarning(
        env,
        "HNS root observations failed",
        "hns_root_observer",
        { ...summary, count: summary.failed },
        { urgency: "high" },
      )
    }
  } catch (error) {
    console.error("[hns-root-observer] sweep failed", error)
    await captureScheduledError(env, error, "hns_root_observer")
  }
}

// The cron fires every minute. Each scheduler worker owns one control-plane
// scope for its whole task lane, so sequential jobs reuse that connection while
// concurrent lanes remain isolated (transactions must never interleave on one
// pg.Client). This caps both peak sessions and per-tick session churn at
// SCHEDULED_JOB_CONCURRENCY; the worker scope closes on normal completion,
// task failure, and deadline-deferred return.
const SCHEDULED_JOB_CONCURRENCY = 2
// Stop STARTING new jobs after this elapsed wall-time; in-flight jobs (≤ the
// concurrency cap, each internally bounded) finish. Keeps a batch comfortably
// under the 60s cron interval (no overlapping invocations stacking connections)
// and far inside the Worker invocation limit (no mid-flight kill leaking a slot).
const SCHEDULED_BATCH_DEADLINE_MS = 30_000
// process_community_jobs polls up to 100 communities sequentially. It is bounded
// by community count but not by time, so under D1 pressure a single tick has run
// 6-7 minutes, holding the scheduler lease and deferring every job behind it —
// including the reward campaign and treasury solvency monitors. Bound the drain
// in wall-time too: unstarted communities roll to the next tick, which the poll
// rotation already accounts for.
const COMMUNITY_JOB_TICK_DEADLINE_MS = 45_000
// Reserve most of the community-job tick for draining runnable work. On staging,
// sweeping all 100 selected communities consumes the full 45s budget by itself,
// leaving the processing phase permanently at zero.
const COMMUNITY_JOB_STALE_SWEEP_DEADLINE_MS = 15_000
// Bound the whole process_community_jobs task, not just the drain. The three
// prelude reconciles and the ops-alert scan each open per-community clients and
// ran unbounded, pushing the task to ~235s against the 120s scheduler lease and
// starving the reward watchdogs queued behind it. 90s keeps the task under the
// lease with headroom for the slowest in-flight community scan to finish.
const COMMUNITY_JOB_TASK_DEADLINE_MS = 90_000
// The three prelude reconciles share one sub-budget so a slow prelude defers
// its own remaining communities instead of eating the drain's 45s — the same
// split philosophy as the 15s/45s sweep/process split. 20s of 90s always
// leaves the drain its full tick budget.
const COMMUNITY_JOB_PRELUDE_DEADLINE_MS = 20_000
const COMMUNITY_PUBLISH_TASK_DEADLINE_MS = 90_000
const COMMUNITY_PUBLISH_RECONCILE_DEADLINE_MS = 15_000
// Protect the settlement/money-path jobs, both reward watchdogs, and
// the community job drain at the front of the ordered batch. They must receive
// a start even when D1 pressure pushes the batch past its nominal deadline.
//
// The drain earns protection because it is not maintenance: it is the retry
// engine for EVERY community job, so deferring it strands user-visible content,
// not just metrics. Measured on prod shard community-d1-pool-0073, only 21% of
// first-attempt-success jobs were picked up within a minute of being enqueued;
// 13% waited more than ten minutes and the worst waited ~8 hours. A song whose
// publish-finalize attempt fails backs off 30s and then waits on this job to get
// a start, which is why "Preparing song features" could linger for half an hour.
export const SCHEDULED_MINIMUM_PRIORITY_STARTS = 13
const SCHEDULED_SLOW_JOB_WARNING_MS = 5_000
// Lease longer than the worst-case batch (deadline + slowest in-flight job) so we
// never expire mid-batch, but bounded so a crashed batch self-heals. Released
// promptly on normal completion.
const SCHEDULED_LEASE_TTL_MS = 120_000
// The community-job lane holds its OWN lease under a distinct DO key, so a slow
// maintenance batch can never make it skip. Named separately from
// SCHEDULED_CRON_LOCK_NAME so the two leases can never collide.
export const SCHEDULED_COMMUNITY_JOB_LOCK_NAME = "scheduled-cron-community-jobs"
export const SCHEDULED_COMMUNITY_PUBLISH_LOCK_NAME = "scheduled-cron-community-publish-finalize"
// Sized to the lane's own deadline plus headroom for the slowest in-flight
// community scan, mirroring how SCHEDULED_LEASE_TTL_MS exceeds its batch
// deadline. Bounded so a crashed lane self-heals rather than wedging the lane
// permanently.
const SCHEDULED_COMMUNITY_JOB_LEASE_TTL_MS = 150_000
// EFP has an explicit 15-minute freshness gate. Keep its small incremental
// scans and confirmed-write reconciliation off the deadline-trimmed maintenance
// tail without adding per-job connections: one lane, one shared scope.
export const SCHEDULED_EFP_LOCK_NAME = "scheduled-cron-efp"
const SCHEDULED_EFP_DEADLINE_MS = 45_000
const SCHEDULED_EFP_LEASE_TTL_MS = 180_000

type ScheduledPriorityJobName =
  | "reconcile_reward_payouts"
  | "reconcile_royalty_claims"
  | "reconcile_booking_settlements"
  | "reverify_booking_payments"
  | "reconcile_purchase_settlements"
  | "reconcile_royalty_allocation_verifications"
  | "reconcile_reward_campaigns"
  | "reconcile_reward_funding_refunds"
  | "reconcile_handle_claims"
  | "reconcile_song_artifact_head_verifications"
  | "monitor_reward_campaign_treasury_solvency"
  | "process_community_jobs"
  | "process_community_publish_finalize"
  | "reconcile_d1_provisioning"
  | "observe_hns_roots"
  | "revalidate_hns_namespaces"
  | "monitor_reward_campaigns"

export function scheduledPriorityJobNames(
  canRunD1Reconciler: boolean,
  canRunHnsNamespaceRevalidation: boolean,
  canRunHnsRootObserver = false,
): ScheduledPriorityJobName[] {
  return [
    "reconcile_reward_payouts",
    "reconcile_royalty_claims",
    "reverify_booking_payments",
    "reconcile_booking_settlements",
    "reconcile_purchase_settlements",
    "reconcile_royalty_allocation_verifications",
    "reconcile_reward_campaigns",
    "reconcile_reward_funding_refunds",
    "reconcile_handle_claims",
    "reconcile_song_artifact_head_verifications",
    // Funded reward campaigns must retain their solvency and lifecycle
    // watchdogs even when community D1 work consumes the nominal batch budget.
    "monitor_reward_campaign_treasury_solvency",
    "monitor_reward_campaigns",
    // Inside the protected base prefix: the drain
    // is the retry engine for every community job, so a deferred start delays
    // user-visible publishing, lyrics, and translations — not just monitoring.
    "process_community_jobs",
    "process_community_publish_finalize",
    // When available, extend the protected prefix so cross-store provisioning
    // cannot strand bindings and root evidence cannot repeatedly miss its
    // freshness budget behind slower maintenance work.
    ...(canRunD1Reconciler ? ["reconcile_d1_provisioning" as const] : []),
    ...(canRunHnsRootObserver ? ["observe_hns_roots" as const] : []),
    ...(canRunHnsNamespaceRevalidation ? ["revalidate_hns_namespaces" as const] : []),
  ]
}

export function scheduledMinimumPriorityStarts(
  canRunD1Reconciler: boolean,
  canRunHnsRootObserver = false,
): number {
  return SCHEDULED_MINIMUM_PRIORITY_STARTS
    + (canRunD1Reconciler ? 1 : 0)
    + (canRunHnsRootObserver ? 1 : 0)
}

const handler: ExportedHandler<Env, RewardQualificationWakeup | ContentSecurityScanMessage> = {
  fetch: fetchApi,

  queue: (batch, env) => withRequestControlPlaneClients(() => {
    if (isContentSecurityScanQueueName(batch.queue)) {
      return consumeContentSecurityScans({
        batch: batch as MessageBatch<ContentSecurityScanMessage>,
        env,
      })
    }
    return consumeRewardQualificationWakeups({
      batch: batch as MessageBatch<RewardQualificationWakeup>,
      env,
    })
  }),

  scheduled: (controller, env, ctx) => {
    if (shouldRunPublicReadCacheCanary(env, controller.scheduledTime || Date.now())) {
      ctx.waitUntil(
        runPublicReadCacheCanary(env)
          .then((result) => console.info(JSON.stringify({
            component: "public_read_cache",
            operation: "eviction_canary",
            ...result,
          })))
          .catch(async (error) => {
            console.error(JSON.stringify({
              component: "public_read_cache",
              operation: "eviction_canary",
              error: error instanceof Error ? error.message : String(error),
            }))
            await withRequestControlPlaneClients(
              () => captureScheduledError(env, error, "public_read_cache_canary"),
            ).catch((alertError) => {
              console.error(JSON.stringify({
                component: "public_read_cache",
                operation: "eviction_canary_alert_delivery",
                error: alertError instanceof Error ? alertError.message : String(alertError),
              }))
            })
          }),
      )
    }

    // Story signer funding watchdog. Read-only RPC (no control-plane connection),
    // internally rate-limited and fully fail-soft, so it runs independently of the
    // DO-leased batch below and cannot destabilise it.
    ctx.waitUntil(
      runStoryRuntimeFundingWatchdog(env).catch((error) => {
        console.error("[scheduled] story funding watchdog crashed (fail-soft)", error)
      }),
    )
    ctx.waitUntil(
      runStorySettlementCoordinatorWatchdog(env).catch((error) => {
        console.error("[scheduled] Story settlement coordinator watchdog crashed (fail-soft)", error)
      }),
    )
    ctx.waitUntil(
      withRequestControlPlaneClients(() => redispatchStaleContentSecurityScanJobs({ env }))
        .then((result) => {
          if (result.enabled && (result.cancelled > 0 || result.selected > 0 || result.failed > 0)) {
            console.info(JSON.stringify({
              component: "content_security_scan",
              operation: "redispatch",
              ...result,
            }))
          }
        })
        .catch((error) => {
          console.error(JSON.stringify({
            component: "content_security_scan",
            operation: "redispatch",
            outcome: "failed",
            error_class: error instanceof Error ? error.name : "unknown",
          }))
        }),
    )
    ctx.waitUntil(
      runRuntimeWalletFundingWatchdog(env).catch((error) => {
        console.error("[scheduled] runtime wallet funding watchdog crashed (fail-soft)", error)
      }),
    )
    ctx.waitUntil(
      withRequestControlPlaneClients(() => checkScheduledD1PoolCapacity(env)).catch((error) => {
        console.error("[scheduled] community D1 pool capacity watchdog crashed (fail-soft)", error)
      }),
    )
    ctx.waitUntil(
      checkHnsEdgeHeartbeatFreshness(env).catch((error) => {
        console.error("[scheduled] HNS edge heartbeat watchdog crashed (fail-soft)", error)
      }),
    )

    // Each concurrency worker opens one control-plane scope below. Jobs in one
    // lane reuse its connection; the two concurrent lanes remain isolated.
    // The deadline bounds when new jobs start (it does NOT cancel in-flight
    // jobs — see runner docs / overlap caveat).
    const canRunD1Reconciler = Boolean(
      env.SHARD_ADMIN_TOKEN && (env.COMMUNITY_D1_SHARD || env.COMMUNITY_D1_SHARD_ROUTES),
    )
    const reconcilerOnly = String(env.COMMUNITY_D1_RECONCILER_ONLY ?? "").trim().toLowerCase() === "true"
    // Recovery and money-path verification must not sit behind the rotating best-effort
    // maintenance tail. Live ticks have shown the deadline deferring settlement, D1
    // provisioning, and royalty-allocation verification after slower community/feed work,
    // so keep them first while lower-priority jobs rotate.
    const priorityJobRuns: Record<ScheduledPriorityJobName, () => Promise<void>> = {
      reconcile_reward_payouts: () => reconcileScheduledRewardPayouts(env),
      reconcile_royalty_claims: () => reconcileScheduledRoyaltyClaims(env),
      reverify_booking_payments: () => reverifyScheduledBookingPayments(env),
      reconcile_booking_settlements: () => reconcileScheduledBookingSettlements(env),
      reconcile_purchase_settlements: () => reconcileScheduledPurchaseSettlements(env),
      reconcile_royalty_allocation_verifications: () => reconcileScheduledRoyaltyAllocationVerifications(env),
      reconcile_reward_campaigns: () => reconcileScheduledRewardCampaigns(env),
      reconcile_reward_funding_refunds: () => reconcileScheduledRewardFundingRefunds(env),
      reconcile_handle_claims: () => reconcileScheduledHandleClaims(env),
      reconcile_song_artifact_head_verifications: () => reconcileScheduledSongArtifactHeadVerifications(env),
      monitor_reward_campaign_treasury_solvency: () => monitorScheduledRewardCampaignTreasurySolvency(env),
      process_community_jobs: () => processScheduledCommunityJobs(env),
      process_community_publish_finalize: () => processScheduledPostPublishFinalizeJobs(env),
      reconcile_d1_provisioning: () => reconcileScheduledD1Provisioning(env),
      observe_hns_roots: () => observeScheduledHnsRoots(env),
      revalidate_hns_namespaces: () => revalidateScheduledHnsNamespaces(env),
      monitor_reward_campaigns: () => monitorScheduledRewardCampaigns(env),
    }
    // Concurrency is two. The protected prefix contains settlement and
    // money-movement paths plus the user-visible community-job drain. When the
    // D1 reconciler is configured, the prefix grows by one: otherwise a slow
    // fixed prefix can defer it on every tick and strand allocated bindings.
    // Monitoring and other maintenance may still defer safely.
    const priorityJobs: NamedTask[] = scheduledPriorityJobNames(
      canRunD1Reconciler,
      isHnsNamespaceRevalidationEnabled(env),
      isHnsRootObserverEnabled(env),
    )
      .map((name) => ({ name, run: priorityJobRuns[name] }))
    const generalJobs: NamedTask[] = [
      ...(env.CONTROL_PLANE_DATABASE_URL
        ? [{
            name: "terminalize_exhausted_dance_attempts",
            run: async () => {
              const summary = await terminalizeExhaustedDanceAttempts({ env })
              if (summary.terminalized > 0 || summary.failed > 0) {
                console.info(
                  "[scheduled] exhausted dance attempt terminalization",
                  summary,
                )
              }
            },
          }]
        : []),
      ...(env.CONTROL_PLANE_DATABASE_URL && env.DANCE_ATTEMPT_S3_ENDPOINT
          && env.DANCE_ATTEMPT_S3_ACCESS_KEY && env.DANCE_ATTEMPT_S3_SECRET_KEY
          && env.DANCE_ATTEMPT_S3_BUCKET
        ? [{
            name: "cleanup_dance_attempts",
            run: async () => {
              const summary = await cleanupDueDanceAttempts({ env })
              if (
                summary.claimed > 0 || summary.expired > 0
                || summary.expired_fingerprints > 0
              ) {
                console.info("[scheduled] dance attempt cleanup", summary)
              }
            },
          }]
        : []),
      ...(isDanceAttemptDispatchConfigured(env)
        ? [{
            name: "dispatch_dance_attempts",
            run: async () => {
              const summary = await dispatchDueDanceAttempts({ env })
              if (summary.claimed > 0) {
                console.info("[scheduled] dance attempt dispatch", summary)
              }
            },
          }]
        : []),
      ...(isDanceReferenceDispatchConfigured(env)
        ? [{
            name: "dispatch_dance_references",
            run: async () => {
              const summary = await dispatchDueDanceReferences({ env })
              if (summary.claimed > 0) {
                console.info("[scheduled] dance reference dispatch", {
                  claimed: summary.claimed,
                  dispatched: summary.dispatched,
                  retry_scheduled: summary.retry_scheduled,
                  exhausted: summary.exhausted,
                  claim_lost: summary.claim_lost,
                })
              }
            },
          }]
        : []),
      ...(env.CONTROL_PLANE_DATABASE_URL && env.BASE_MAINNET_RPC_URL
        ? [{
            name: "scan_efp_base",
            run: () => scanScheduledEfpChain(env, EFP_INDEXER_CHAINS.base, env.BASE_MAINNET_RPC_URL),
          }]
        : []),
      ...(env.CONTROL_PLANE_DATABASE_URL && env.OPTIMISM_MAINNET_RPC_URL
        ? [{
            name: "scan_efp_optimism",
            run: () => scanScheduledEfpChain(env, EFP_INDEXER_CHAINS.optimism, env.OPTIMISM_MAINNET_RPC_URL),
          }]
        : []),
      ...(env.CONTROL_PLANE_DATABASE_URL && env.ETHEREUM_RPC_URL
        ? [{
            name: "scan_efp_ethereum",
            run: () => scanScheduledEfpChain(env, EFP_INDEXER_CHAINS.ethereum, env.ETHEREUM_RPC_URL),
          }]
        : []),
      ...(env.CONTROL_PLANE_DATABASE_URL
        ? [{ name: "reconcile_efp_follow_writes", run: () => reconcileScheduledEfpFollowWrites(env) }]
        : []),
      ...(env.CONTROL_PLANE_DATABASE_URL
        ? [{ name: "reconcile_content_blob_lifecycle", run: () => reconcileScheduledContentBlobs(env) }]
        : []),
      ...(env.CONTROL_PLANE_DATABASE_URL && env.GENERIC_DIGITAL_GOODS_ENABLED === "true"
        ? [{ name: "reconcile_generic_asset_payloads", run: () => reconcileScheduledGenericAssetPayloads(env) }]
        : []),
      { name: "flush_analytics", run: () => flushScheduledAnalytics(env) },
      { name: "sync_community_health_counts", run: () => syncScheduledCommunityHealthCounts(env) },
      { name: "reconcile_membership_projections", run: () => reconcileScheduledCommunityMembershipProjections(env) },
      { name: "reconcile_song_practice_rewards", run: () => reconcileScheduledSongPracticeRewards(env) },
      { name: "enforce_reward_nationality_retention", run: () => enforceScheduledRewardNationalityRetention(env) },
      { name: "refresh_materialized_public_feeds", run: () => refreshScheduledMaterializedPublicHomeFeeds(env) },
    ]
    const rotatedJobs: NamedTask[] = [
      ...(reconcilerOnly ? [] : generalJobs),
    ]
    // Rotate the start order each minute so a deadline-trimmed tail never starves
    // the same jobs run after run.
    const minute = Math.floor((controller.scheduledTime || Date.now()) / 60_000)
    const offset = rotatedJobs.length > 0 ? ((minute % rotatedJobs.length) + rotatedJobs.length) % rotatedJobs.length : 0
    const ordered = [
      ...priorityJobs,
      ...rotatedJobs.slice(offset),
      ...rotatedJobs.slice(0, offset),
    ].map((job) => ({
      name: job.name,
      run: async () => {
        const startedAt = Date.now()
        try {
          await job.run()
        } finally {
          const durationMs = Date.now() - startedAt
          if (durationMs >= SCHEDULED_SLOW_JOB_WARNING_MS) {
            console.warn(`[scheduled] slow job: ${job.name} took ${durationMs}ms`)
          }
        }
      },
    }))

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
    // Three lanes, three leases, run concurrently.
    //
    // Community jobs are foreground delivery work — the retry engine for every
    // community job, including Telegram channel publishing. Maintenance
    // (reward reconciles, monitors, HNS observers) is slow and bounded only by
    // its own deadlines. Sharing ONE lease made the slow side gate the fast
    // one: a maintenance batch overrunning the 60s cron interval left every
    // subsequent tick logging "lease held … 0 jobs started", so ready community
    // jobs waited tens of minutes behind work nobody was waiting on. Measured
    // on staging: task_ms 92371 against a 90s deadline, and 2/2 observed ticks
    // skipped outright.
    //
    // Each lane keeps its own DO lease, so overlap protection is UNCHANGED:
    // exactly one batch per lane runs cluster-wide, and the per-job CAS/lease
    // inside the community runner is untouched. A lane whose lease is held
    // still skips — it just can no longer make the other lane skip with it.
    const lanes = splitScheduledLanes(ordered)
    const owner = crypto.randomUUID()
    const namespace = env.SCHEDULED_CRON_LOCK as DurableObjectNamespace<ScheduledCronLockDO>
    const laneStartedAtMs = Date.now()

    const runLane = async (input: {
      lane: string
      lockName?: string
      deadlineMs: number
      leaseTtlMs: number
      limit: number
      minimumStartsBeforeDeadline?: number
      tasks: typeof ordered
    }): Promise<void> => {
      if (input.tasks.length === 0) return
      const startedAt = Date.now()
      try {
        await runScheduledBatch({
          deadlineMs: input.deadlineMs,
          leaseTtlMs: input.leaseTtlMs,
          limit: input.limit,
          lock: createDurableObjectCronLock(namespace, input.lockName),
          minimumStartsBeforeDeadline: input.minimumStartsBeforeDeadline,
          onError: (error, name) => console.error(`[scheduled:${input.lane}] job failed: ${name}`, error),
          onLeaseHeld: () => console.warn(`[scheduled:${input.lane}] lease held by another invocation — skipping batch (0 jobs started)`),
          onSkipped: (skipped) => console.warn(`[scheduled:${input.lane}] deferred ${skipped.length} job(s) past the ${input.deadlineMs}ms deadline: ${skipped.join(", ")}`),
          owner,
          tasks: input.tasks,
          workerScope: withRequestControlPlaneClients,
        })
      } finally {
        // Per-lane duration is the signal that tells the two lanes apart when
        // one of them is the reason a tick ran long.
        console.info(`[scheduled:${input.lane}] lane finished`, JSON.stringify({
          lane: input.lane,
          lane_ms: Date.now() - startedAt,
          tick_ms: Date.now() - laneStartedAtMs,
          tasks: input.tasks.length,
        }))
      }
    }

    ctx.waitUntil(Promise.allSettled([
      runLane({
        lane: "community-publish",
        lockName: SCHEDULED_COMMUNITY_PUBLISH_LOCK_NAME,
        deadlineMs: COMMUNITY_PUBLISH_TASK_DEADLINE_MS,
        leaseTtlMs: SCHEDULED_COMMUNITY_JOB_LEASE_TTL_MS,
        limit: 1,
        tasks: lanes.publishing,
      }),
      runLane({
        lane: "community-jobs",
        lockName: SCHEDULED_COMMUNITY_JOB_LOCK_NAME,
        // The drain bounds itself internally (task/tick/sweep budgets); this is
        // the outer stop so a wedged lane cannot hold its lease indefinitely.
        deadlineMs: COMMUNITY_JOB_TASK_DEADLINE_MS,
        leaseTtlMs: SCHEDULED_COMMUNITY_JOB_LEASE_TTL_MS,
        limit: 1,
        tasks: lanes.community,
      }),
      runLane({
        lane: "efp",
        lockName: SCHEDULED_EFP_LOCK_NAME,
        deadlineMs: SCHEDULED_EFP_DEADLINE_MS,
        leaseTtlMs: SCHEDULED_EFP_LEASE_TTL_MS,
        limit: 1,
        // The four tasks are one correctness unit: all three expected-chain
        // cursors plus confirmed-write reconciliation must receive a start.
        minimumStartsBeforeDeadline: lanes.efp.length,
        tasks: lanes.efp,
      }),
      runLane({
        lane: "maintenance",
        deadlineMs: SCHEDULED_BATCH_DEADLINE_MS,
        leaseTtlMs: SCHEDULED_LEASE_TTL_MS,
        limit: SCHEDULED_JOB_CONCURRENCY,
        minimumStartsBeforeDeadline: scheduledMinimumPriorityStarts(
          canRunD1Reconciler,
          isHnsRootObserverEnabled(env),
        ),
        tasks: lanes.maintenance,
      }),
    ]).then(() => undefined))
  },
}

export class CachedPublicReads extends WorkerEntrypoint<Env> {
  async fetch(request: Request): Promise<Response> {
    return withRequestControlPlaneClients(async () => publicReadApp.fetch(request, this.env, this.ctx))
  }

  /**
   * Evicts cached public reads by `Cache-Tag`.
   *
   * Workers Caching is a distinct layer from the zone CDN cache: no zone-level
   * purge reaches it, and a purge only affects the entrypoint that issues it.
   * Public reads are cached here (see the `CachedPublicReads` export config in
   * wrangler.jsonc), so this must run inside this class — calling
   * `ctx.cache.purge()` from the default entrypoint would target that
   * entrypoint's own (disabled) cache and silently do nothing.
   */
  async purgeCacheTags(tags: string[]): Promise<{ success: boolean; errors?: unknown }> {
    const unique = [...new Set(tags)].filter((tag) => tag.length > 0)
    if (unique.length === 0) {
      return { success: true }
    }
    const cache = this.ctx.cache
    if (!cache) {
      // Report rather than swallow: without this layer the invalidation is a
      // no-op and public reads stay stale until their own TTL expires, which is
      // exactly the failure this method exists to prevent.
      return { success: false, errors: [{ message: "Workers cache purge is unavailable on this runtime" }] }
    }
    const result = await cache.purge({ tags: unique })
    return { success: result.success, errors: result.errors }
  }
}

export { app }
export default handler
