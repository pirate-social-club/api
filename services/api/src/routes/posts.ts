import { Hono } from "hono"
import { badRequestError, errorResponse } from "../lib/errors"
import { getUserRepository } from "../lib/auth/repositories"
import { getControlPlaneCommunityRepository } from "../lib/communities/control-plane-community-repository"
import { requireBearerToken } from "../lib/helpers"
import { castPostVote, getPost } from "../lib/posts/post-service"
import type { Env } from "../types"

const posts = new Hono<{ Bindings: Env }>()

posts.get("/:postId", async (c) => {
  try {
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
  } catch (error) {
    const response = errorResponse(error)
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    })
  }
})

posts.post("/:postId/vote", async (c) => {
  try {
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
  } catch (error) {
    const response = errorResponse(error)
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    })
  }
})

export default posts
