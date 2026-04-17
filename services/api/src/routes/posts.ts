import { Hono } from "hono"
import { badRequestError } from "../lib/errors"
import { getUserRepository } from "../lib/auth/repositories"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { authenticate, type AuthenticatedEnv } from "../lib/auth-middleware"
import { castPostVote, getPost } from "../lib/posts/post-service"

const posts = new Hono<AuthenticatedEnv>()

posts.use("*", authenticate)

posts.get("/:postId", async (c) => {
  const actor = c.get("actor")
  const communityRepository = getCommunityRepository(c.env)
  const result = await getPost({
    env: c.env,
    userId: actor.userId,
    postId: c.req.param("postId"),
    locale: c.req.query("locale") ?? null,
    communityRepository,
  })
  return c.json(result, 200)
})

posts.post("/:postId/vote", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ value?: number }>().catch(() => null)
  if (!body || (body.value !== -1 && body.value !== 1)) {
    throw badRequestError("Vote value must be -1 or 1")
  }

  const result = await castPostVote({
    env: c.env,
    userId: actor.userId,
    postId: c.req.param("postId"),
    value: body.value,
    userRepository: getUserRepository(c.env),
    communityRepository: getCommunityRepository(c.env),
  })
  return c.json(result, 200)
})

export default posts
