import { Hono } from "hono"
import { cors } from "hono/cors"
import auth from "./routes/auth"
import communityMedia from "./routes/community-media"
import communities from "./routes/communities"
import jobs from "./routes/jobs"
import onboarding from "./routes/onboarding"
import posts from "./routes/posts"
import publicProfiles from "./routes/public-profiles"
import profileMedia from "./routes/profile-media"
import profiles from "./routes/profiles"
import users from "./routes/users"
import verification from "./routes/verification"
import { errorResponse } from "./lib/errors"
import type { Env } from "./types"

const app = new Hono<{ Bindings: Env }>()

app.use(
  "/*",
  cors({
    origin: "*",
    allowMethods: ["GET", "POST", "PUT", "PATCH", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  }),
)

app.get("/health", (c) => c.json({ ok: true }))
app.route("/auth", auth)
app.route("/community-media", communityMedia)
app.route("/communities", communities)
app.route("/jobs", jobs)
app.route("/posts", posts)
app.route("/public-profiles", publicProfiles)
app.route("/profile-media", profileMedia)
app.route("/users", users)
app.route("/onboarding", onboarding)
app.route("/profiles", profiles)
app.route("/", verification)

app.notFound((c) => c.json({ code: "not_found", message: "Not found" }, 404))

app.onError((error, c) => {
  console.error("[api-worker]", error)
  const response = errorResponse(error)
  return new Response(JSON.stringify(response.body), {
    status: response.status,
    headers: {
      "content-type": "application/json",
    },
  })
})

export default app
