import { Hono } from "hono"
import { authError } from "../lib/errors"
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

export default users
