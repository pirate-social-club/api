import { Hono } from "hono"
import feed from "./feed"
import publicComments from "./public-comments"
import publicCommunities from "./public-communities"
import publicPosts from "./public-posts"
import type { Env } from "../env"
import { apiErrorHandler } from "./api-error-handler"

const publicReadApp = new Hono<{ Bindings: Env }>()
publicReadApp.route("/feed", feed)
publicReadApp.route("/public-comments", publicComments)
publicReadApp.route("/public-communities", publicCommunities)
publicReadApp.route("/public-posts", publicPosts)
publicReadApp.onError(apiErrorHandler)

export default publicReadApp
