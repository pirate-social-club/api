import { Hono } from "hono"
import { authError } from "../lib/errors"
import { requireBearerToken } from "../lib/helpers"
import { verifyPirateAccessToken } from "../lib/auth/pirate-session-token"
import { getUserRepository } from "../lib/auth/repositories"
import { getControlPlaneCommunityRepository } from "../lib/communities/control-plane-community-repository"
import { openCommunityDb } from "../lib/communities/community-db-factory"
import { hasUserCreatedPostType } from "../lib/posts/community-post-store"
import { handleRoute } from "./route-helpers"
import type { Env } from "../types"

const users = new Hono<{ Bindings: Env }>()

async function resolveCommunityByReference(env: Env, communityRef: string) {
  const repository = getControlPlaneCommunityRepository(env)
  const normalized = communityRef.trim()
  if (!normalized) {
    return null
  }

  const direct = await repository.getCommunityById(normalized)
  if (direct) {
    return direct
  }

  if (normalized.startsWith("@")) {
    const namespaceLabel = normalized.replace(/^@+/, "").toLowerCase()
    if (!namespaceLabel) {
      return null
    }

    return repository.getCommunityByNamespaceLabel({
      normalizedLabel: namespaceLabel,
      family: "spaces",
    })
  }

  const routeKey = normalized.replace(/^@+/, "").toLowerCase()
  if (!routeKey) {
    return null
  }

  return repository.getCommunityByRouteKey(routeKey)
}

users.get("/me", handleRoute(async (c) => {
  const token = requireBearerToken(c.req.header("authorization"))
  const session = await verifyPirateAccessToken({
    env: c.env,
    token,
  })
  const repository = getUserRepository(c.env)
  const user = await repository.getUserById(session.userId)
  if (!user) {
    throw authError("Authentication failed")
  }

  const communityRef = String(c.req.query("community_ref") || "").trim()
  if (!communityRef) {
    return c.json(user, 200)
  }

  const community = await resolveCommunityByReference(c.env, communityRef)
  if (!community) {
    return c.json({
      ...user,
      community_posting_state: null,
    }, 200)
  }

  const communityRepository = getControlPlaneCommunityRepository(c.env)
  const db = await openCommunityDb(communityRepository, community.community_id).catch(() => null)
  if (!db) {
    return c.json({
      ...user,
      community_posting_state: null,
    }, 200)
  }

  try {
    const hasCreatedTextPost = await hasUserCreatedPostType({
      client: db.client,
      communityId: community.community_id,
      authorUserId: session.userId,
      postType: "text",
    })

    return c.json({
      ...user,
      community_posting_state: {
        community_ref: communityRef,
        community_id: community.community_id,
        has_created_text_post: hasCreatedTextPost,
      },
    }, 200)
  } finally {
    db.close()
  }
}))

export default users
