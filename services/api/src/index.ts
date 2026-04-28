import { Hono } from "hono"
import { cors } from "hono/cors"
import agents from "./routes/agents"
import analytics from "./routes/analytics"
import auth from "./routes/auth"
import communityMedia from "./routes/community-media"
import comments from "./routes/comments"
import communities from "./routes/communities"
import discovery from "./routes/discovery"
import feed from "./routes/feed"
import jobs from "./routes/jobs"
import notifications from "./routes/notifications"
import onboarding from "./routes/onboarding"
import posts from "./routes/posts"
import publicComments from "./routes/public-comments"
import publicAgents from "./routes/public-agents"
import publicCommunities from "./routes/public-communities"
import publicPosts from "./routes/public-posts"
import publicProfiles from "./routes/public-profiles"
import profileMedia from "./routes/profile-media"
import profiles from "./routes/profiles"
import royalties from "./routes/royalties"
import users from "./routes/users"
import verification from "./routes/verification"
import { flushAnalyticsOutbox, isAnalyticsEnabled } from "./lib/analytics"
import { getCommunityRepository } from "./lib/communities/db-community-repository"
import { processAvailableCommunityJobs } from "./lib/communities/jobs/runner"
import { HttpError, errorResponse } from "./lib/errors"
import { getControlPlaneClient } from "./lib/runtime-deps"
import type { Env } from "./types"

const app = new Hono<{ Bindings: Env }>()

app.use(
  "/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "X-Agent-Connection-Token",
      "X-Pirate-Anonymous-Id",
      "X-Pirate-Session-Id",
    ],
  }),
)

app.get("/health", (c) => c.json({ ok: true }))
app.route("/", discovery)
app.route("/", agents)
app.route("/analytics", analytics)
app.route("/auth", auth)
app.route("/community-media", communityMedia)
app.route("/comments", comments)
app.route("/communities", communities)
app.route("/feed", feed)
app.route("/jobs", jobs)
app.route("/notifications", notifications)
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
      console.log("[community-jobs] scheduled processed", JSON.stringify({
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
    communityRepository.close?.()
  }
}

;(app as ScheduledApp).scheduled = async (_controller, env, ctx) => {
  ctx.waitUntil(flushScheduledAnalytics(env))
  ctx.waitUntil(processScheduledCommunityJobs(env))
}

export default app
