import { Hono } from "hono"
import { authError, badRequestError } from "../lib/errors"
import { getUserRepository } from "../lib/auth/repositories"
import { authenticate, type AuthenticatedEnv } from "../lib/auth-middleware"
import { getCommunityRepository } from "../lib/communities/db-community-repository"
import { resolveCommunityIdentifier } from "../lib/communities/community-identifier"
import {
  consumeTelegramAccountLinkIntent,
  createTelegramAccountLinkIntent,
} from "../lib/telegram/account-link-service"
import { serializeUser } from "../serializers/user"

const users = new Hono<AuthenticatedEnv>()

users.use("*", authenticate)

users.get("/me", async (c) => {
  const actor = c.get("actor")
  const repository = getUserRepository(c.env)
  const user = await repository.getUserById(actor.userId)
  if (!user) {
    throw authError("Authentication failed")
  }
  return c.json(serializeUser(user), 200)
})

users.post("/me/telegram-account-link-intents", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ community_id?: unknown }>().catch(() => null)
  const communityIdentifier =
    typeof body?.community_id === "string" ? body.community_id.trim() : ""
  if (!communityIdentifier) {
    throw badRequestError("community_id is required")
  }
  const communityId = await resolveCommunityIdentifier(
    getCommunityRepository(c.env),
    communityIdentifier,
  )
  if (!communityId) throw badRequestError("Community was not found")
  return c.json(await createTelegramAccountLinkIntent({
    communityId,
    env: c.env,
    sourceUserId: actor.userId,
  }), 201)
})

users.post("/me/telegram-account-link-intents/consume", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ token?: unknown }>().catch(() => null)
  const token = typeof body?.token === "string" ? body.token : ""
  return c.json(await consumeTelegramAccountLinkIntent({
    env: c.env,
    targetUserId: actor.userId,
    token,
  }), 200)
})

// Explicitly choose the identity (primary) wallet — used for the public profile address, ENS,
// messaging, and creator ownership. Authentication never changes this; only this endpoint does.
users.put("/me/identity-wallet", async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ wallet_attachment_id?: unknown }>().catch(() => null)
  const walletAttachmentId = typeof body?.wallet_attachment_id === "string" ? body.wallet_attachment_id.trim() : ""
  if (!walletAttachmentId) {
    throw badRequestError("A valid wallet_attachment_id is required")
  }

  const repository = getUserRepository(c.env)
  const user = await repository.setIdentityWallet(actor.userId, walletAttachmentId)
  if (!user) {
    throw authError("Authentication failed")
  }
  return c.json(serializeUser(user), 200)
})

export default users
