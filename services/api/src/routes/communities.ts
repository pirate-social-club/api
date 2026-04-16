import { Hono } from "hono"
import { badRequestError } from "../lib/errors"
import { getUserRepository } from "../lib/auth/repositories"
import {
  attachNamespaceToCommunity,
  createCommunity,
  getCommunity,
  getCommunityPreview,
  getJoinEligibility,
  joinCommunity,
  setPendingNamespaceVerificationSession,
  type CreateCommunityRequestBody,
} from "../lib/communities/community-service"
import { getCommunityRepository } from "../lib/communities/control-plane-community-repository"
import { getControlPlaneVerificationRepository } from "../lib/verification/control-plane-verification-repository"
import { authenticate, type AuthenticatedEnv } from "../lib/auth-middleware"
import { createPost, listCommunityPosts } from "../lib/posts/post-service"
import type { CreatePostRequest } from "../types"

const communities = new Hono<AuthenticatedEnv>()

communities.use("*", authenticate)

communities.post("/", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<CreateCommunityRequestBody>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid community create payload")
  }

  const result = await createCommunity({
    env: c.env,
    userId: actor.userId,
    body,
    userRepository: getUserRepository(c.env),
    verificationRepository: getControlPlaneVerificationRepository(c.env),
    communityRepository: getCommunityRepository(c.env),
  })
  return c.json(result, 202)
})

communities.get("/:communityId", async (c) => {
  const actor = c.get("actor")
  const repository = getCommunityRepository(c.env)
  const result = await getCommunity({
    env: c.env,
    userId: actor.userId,
    communityId: c.req.param("communityId"),
    repository,
  })
  return c.json(result, 200)
})

communities.get("/:communityId/preview", async (c) => {
  const actor = c.get("actor")
  const result = await getCommunityPreview({
    env: c.env,
    userId: actor.userId,
    communityId: c.req.param("communityId"),
    communityRepository: getCommunityRepository(c.env),
  })
  return c.json(result, 200)
})

communities.get("/:communityId/join-eligibility", async (c) => {
  const actor = c.get("actor")
  const result = await getJoinEligibility({
    env: c.env,
    userId: actor.userId,
    communityId: c.req.param("communityId"),
    userRepository: getUserRepository(c.env),
    communityRepository: getCommunityRepository(c.env),
  })
  return c.json(result, 200)
})

communities.post("/:communityId/namespace", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ namespace_verification_id?: string | null }>().catch(() => null)
  const namespaceVerificationId = body?.namespace_verification_id?.trim()
  if (!namespaceVerificationId) {
    throw badRequestError("namespace_verification_id is required")
  }

  const result = await attachNamespaceToCommunity({
    env: c.env,
    userId: actor.userId,
    communityId: c.req.param("communityId"),
    namespaceVerificationId,
    userRepository: getUserRepository(c.env),
    verificationRepository: getControlPlaneVerificationRepository(c.env),
    communityRepository: getCommunityRepository(c.env),
  })
  return c.json(result, 200)
})

communities.put("/:communityId/pending-namespace-session", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ namespace_verification_session_id?: string | null }>().catch(() => null)
  const sessionId = typeof body?.namespace_verification_session_id === "string"
    ? body.namespace_verification_session_id.trim() || null
    : null

  const result = await setPendingNamespaceVerificationSession({
    env: c.env,
    userId: actor.userId,
    communityId: c.req.param("communityId"),
    sessionId,
    communityRepository: getCommunityRepository(c.env),
  })
  return c.json(result, 200)
})

communities.post("/:communityId/join", async (c) => {
  const actor = c.get("actor")
  const result = await joinCommunity({
    env: c.env,
    userId: actor.userId,
    communityId: c.req.param("communityId"),
    userRepository: getUserRepository(c.env),
    communityRepository: getCommunityRepository(c.env),
  })
  return c.json(result, 200)
})

communities.post("/:communityId/posts", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<CreatePostRequest>().catch(() => null)
  if (!body) {
    throw badRequestError("Invalid post create payload")
  }

  const userRepository = getUserRepository(c.env)
  const communityRepository = getCommunityRepository(c.env)
  const result = await createPost({
    env: c.env,
    userId: actor.userId,
    communityId: c.req.param("communityId"),
    body,
    userRepository,
    communityRepository,
  })
  return c.json(result, result.status === "published" ? 201 : 202)
})

communities.get("/:communityId/posts", async (c) => {
  const actor = c.get("actor")
  const communityRepository = getCommunityRepository(c.env)
  const result = await listCommunityPosts({
    env: c.env,
    userId: actor.userId,
    communityId: c.req.param("communityId"),
    locale: c.req.query("locale") ?? null,
    limit: c.req.query("limit") ?? null,
    cursor: c.req.query("cursor") ?? null,
    flairId: c.req.query("flair_id") ?? null,
    communityRepository,
  })
  return c.json(result, 200)
})

export default communities
