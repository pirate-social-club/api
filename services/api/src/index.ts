import { Hono } from "hono"
import { cors } from "hono/cors"
import agents from "./routes/agents"
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
import users from "./routes/users"
import verification from "./routes/verification"
import { HttpError, errorResponse } from "./lib/errors"
import type { Env } from "./types"

const app = new Hono<{ Bindings: Env }>()

app.use(
  "/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Agent-Connection-Token"],
  }),
)

app.get("/health", (c) => c.json({ ok: true }))
app.route("/", discovery)
app.route("/", agents)
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

export default app
