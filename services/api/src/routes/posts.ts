import { Hono } from "hono"
import { badRequestError } from "../lib/errors"
import { getUserRepository } from "../lib/auth/repositories"
import { getControlPlaneCommunityRepository } from "../lib/communities/control-plane-community-repository"
import { requireBearerToken } from "../lib/helpers"
import { castPostVote, getPost } from "../lib/posts/post-service"
import { handleRoute } from "./route-helpers"
import type { Env } from "../types"

const posts = new Hono<{ Bindings: Env }>()

posts.get("/:postId", handleRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const communityRepository = getControlPlaneCommunityRepository(c.env)
  const result = await getPost({
    env: c.env,
    bearerToken: token,
    postId: c.req.param("postId"),
    locale: c.req.query("locale") ?? null,
    communityRepository,
  })
  return c.json(result, 200)
}))

posts.post("/:postId/vote", handleRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const body = await c.req.json<{ value?: number }>().catch(() => null)
  if (!body || (body.value !== -1 && body.value !== 1)) {
    throw badRequestError("Vote value must be -1 or 1")
  }

  const result = await castPostVote({
    env: c.env,
    bearerToken: token,
    postId: c.req.param("postId"),
    value: body.value,
    userRepository: getUserRepository(c.env),
    communityRepository: getControlPlaneCommunityRepository(c.env),
  })
  return c.json(result, 200)
}))

export default posts
