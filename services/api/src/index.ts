import { Hono } from "hono"
import { cors } from "hono/cors"
import agents from "./routes/agents"
import analytics from "./routes/analytics"
import auth from "./routes/auth"
import botUsers from "./routes/bot-users"
import communityMedia from "./routes/community-media"
import comments from "./routes/comments"
import communities from "./routes/communities"
import discovery from "./routes/discovery"
import feed from "./routes/feed"
import jobs from "./routes/jobs"
import notifications from "./routes/notifications"
import royalties from "./routes/royalties"
import onboarding from "./routes/onboarding"
import posts from "./routes/posts"
import publicComments from "./routes/public-comments"
import publicAgents from "./routes/public-agents"
import publicCommunities from "./routes/public-communities"
import publicPosts from "./routes/public-posts"
import publicProfiles from "./routes/public-profiles"
import profileMedia from "./routes/profile-media"
import profiles from "./routes/profiles"
import users from "./routes/users"
import verification from "./routes/verification"
import { flushAnalyticsOutbox, isAnalyticsEnabled } from "./lib/analytics"
import { getCommunityRepository } from "./lib/communities/db-community-repository"
import { reconcileStaleCommunityPurchaseSettlements } from "./lib/communities/commerce/settlement-service"
import { processAvailableCommunityJobs } from "./lib/communities/jobs/runner"
import { reconcileCommunityMembershipAndFollowProjections } from "./lib/communities/membership/projection-service"
import { HttpError, errorResponse } from "./lib/errors"
import { reconcileRoyaltyClaimEvents } from "./lib/royalties/royalty-claim-history"
import { getControlPlaneClient, withRequestControlPlaneClients } from "./lib/runtime-deps"
import type { Env } from "./types"

const app = new Hono<{ Bindings: Env }>()

function configuredCorsOrigin(origin: string, c: { env: Env }): string | null {
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

app.use(
  "/*",
  cors({
    origin: configuredCorsOrigin,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-Admin-As-User-Id",
      "X-Admin-Token",
      "X-Agent-Connection-Token",
      "X-Pirate-Anonymous-Id",
      "X-Pirate-Session-Id",
    ],
  }),
)

app.use("*", async (_c, next) => {
  await withRequestControlPlaneClients(next)
})

app.get("/health", (c) => c.json({ ok: true }))
app.route("/", discovery)
app.route("/", agents)
app.route("/analytics", analytics)
app.route("/auth", auth)
app.route("/admin/bot-users", botUsers)
app.route("/community-media", communityMedia)
app.route("/comments", comments)
app.route("/communities", communities)
app.route("/feed", feed)
app.route("/jobs", jobs)
app.route("/notifications", notifications)
app.route("/royalties", royalties)
app.route("/posts", posts)
app.route("/public-comments", publicComments)
app.route("/public-agents", publicAgents)
app.route("/public-communities", publicCommunities)
app.route("/public-posts", publicPosts)
app.route("/public-profiles", publicProfiles)
app.route("/profile-media", profileMedia)
app.route("/users", users)
app.route("/onboarding", onboarding)
app.route("/profiles", profiles)
app.route("/royalties", royalties)
app.route("/", verification)

app.notFound((c) => c.json({ code: "not_found", message: "Not found" }, 404))

app.onError((error) => {
  if (!(error instanceof HttpError) || error.status >= 500) {
    console.error("[api-worker]", error)
  }
  const response = errorResponse(error)
  return new Response(JSON.stringify(response.body), {
    status: response.status,
    headers: {
      "content-type": "application/json",
    },
  })
})

type ScheduledApp = typeof app & {
  scheduled: NonNullable<ExportedHandler<Env>["scheduled"]>
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
  } finally {
    await communityRepository.close?.()
  }
}

;(app as ScheduledApp).scheduled = async (_controller, env, ctx) => {
  ctx.waitUntil(withRequestControlPlaneClients(() => flushScheduledAnalytics(env)))
  ctx.waitUntil(withRequestControlPlaneClients(() => processScheduledCommunityJobs(env)))
  ctx.waitUntil(withRequestControlPlaneClients(() => reconcileScheduledCommunityMembershipProjections(env)))
  ctx.waitUntil(withRequestControlPlaneClients(() => reconcileScheduledRoyaltyClaims(env)))
  ctx.waitUntil(withRequestControlPlaneClients(() => reconcileScheduledPurchaseSettlements(env)))
}

export default app
