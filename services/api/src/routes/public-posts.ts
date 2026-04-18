import { Hono } from "hono"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { getPublicPost } from "../lib/posts/post-service"
import type { Env } from "../types"

const publicPosts = new Hono<{ Bindings: Env }>()

publicPosts.get("/:postId", async (c) => {
  const result = await getPublicPost({
    env: c.env,
    postId: c.req.param("postId"),
    locale: c.req.query("locale") ?? null,
    communityRepository: getCommunityRepository(c.env),
  })
  return c.json(result, 200)
})

export default publicPosts
