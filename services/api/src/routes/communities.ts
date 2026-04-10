import { Hono } from "hono"
import { badRequestError, errorResponse } from "../lib/errors"
import { getUserRepository } from "../lib/auth/repositories"
import { createCommunity, getCommunity, joinCommunity, type CreateCommunityRequestBody } from "../lib/communities/community-service"
import { getControlPlaneCommunityRepository } from "../lib/communities/control-plane-community-repository"
import { getControlPlaneVerificationRepository } from "../lib/verification/control-plane-verification-repository"
import { requireBearerToken } from "../lib/helpers"
import { createPost, listCommunityPosts } from "../lib/posts/post-service"
import type { CreatePostRequest } from "../types"
import type { Env } from "../types"

const communities = new Hono<{ Bindings: Env }>()

communities.post("/", async (c) => {
  try {
    const token = requireBearerToken(c.req.header("authorization"))
    const body = await c.req.json<CreateCommunityRequestBody>().catch(() => null)
    if (!body) {
      throw badRequestError("Invalid community create payload")
    }

    const result = await createCommunity({
      env: c.env,
      bearerToken: token,
      body,
      userRepository: getUserRepository(c.env),
      verificationRepository: getControlPlaneVerificationRepository(c.env),
      communityRepository: getControlPlaneCommunityRepository(c.env),
    })
    return c.json(result, 202)
  } catch (error) {
    const response = errorResponse(error)
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    })
  }
})

communities.get("/:communityId", async (c) => {
  try {
    const token = requireBearerToken(c.req.header("authorization"))
    const repository = getControlPlaneCommunityRepository(c.env)
    const result = await getCommunity({
      env: c.env,
      bearerToken: token,
      communityId: c.req.param("communityId"),
      repository,
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

communities.post("/:communityId/join", async (c) => {
  try {
    const token = requireBearerToken(c.req.header("authorization"))
    const result = await joinCommunity({
      env: c.env,
      bearerToken: token,
      communityId: c.req.param("communityId"),
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

communities.post("/:communityId/posts", async (c) => {
  try {
    const token = requireBearerToken(c.req.header("authorization"))
    const body = await c.req.json<CreatePostRequest>().catch(() => null)
    if (!body) {
      throw badRequestError("Invalid post create payload")
    }

    const userRepository = getUserRepository(c.env)
    const communityRepository = getControlPlaneCommunityRepository(c.env)
    const result = await createPost({
      env: c.env,
      bearerToken: token,
      communityId: c.req.param("communityId"),
      body,
      userRepository,
      communityRepository,
    })
    return c.json(result, result.status === "published" ? 201 : 202)
  } catch (error) {
    const response = errorResponse(error)
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { "content-type": "application/json" },
    })
  }
})

communities.get("/:communityId/posts", async (c) => {
  try {
    const token = requireBearerToken(c.req.header("authorization"))
    const communityRepository = getControlPlaneCommunityRepository(c.env)
    const result = await listCommunityPosts({
      env: c.env,
      bearerToken: token,
      communityId: c.req.param("communityId"),
      locale: c.req.query("locale") ?? null,
      limit: c.req.query("limit") ?? null,
      cursor: c.req.query("cursor") ?? null,
      flairId: c.req.query("flair_id") ?? null,
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

export default communities
