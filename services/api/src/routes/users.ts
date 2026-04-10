import { Hono } from "hono"
import { authError, errorResponse } from "../lib/errors"
import { requireBearerToken } from "../lib/helpers"
import { verifyPirateAccessToken } from "../lib/auth/pirate-session-token"
import { getUserRepository } from "../lib/auth/repositories"
import type { Env } from "../types"

const users = new Hono<{ Bindings: Env }>()

users.get("/me", async (c) => {
  try {
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
    return c.json(user, 200)
  } catch (error) {
    const response = errorResponse(error)
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: {
        "content-type": "application/json",
      },
    })
  }
})

export default users
