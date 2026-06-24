import { Hono } from "hono"
import { authError, badRequestError } from "../lib/errors"
import { getUserRepository } from "../lib/auth/repositories"
import { authenticate, type AuthenticatedEnv } from "../lib/auth-middleware"
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
