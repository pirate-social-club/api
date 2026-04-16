import { createMiddleware } from "hono/factory"
import { authError } from "./errors"
import { verifyPirateAccessToken } from "./auth/pirate-session-token"
import type { Env } from "../types"

export type ActorContext = {
  userId: string
}

type AuthenticatedVariables = {
  actor: ActorContext
}

function requireBearerToken(headerValue: string | undefined): string {
  if (!headerValue || !headerValue.startsWith("Bearer ")) {
    throw authError("Authentication failed")
  }
  return headerValue.slice("Bearer ".length)
}

export const authenticate = createMiddleware<{ Bindings: Env; Variables: AuthenticatedVariables }>(
  async (c, next) => {
    const token = requireBearerToken(c.req.header("authorization"))
    const session = await verifyPirateAccessToken({ env: c.env, token })
    c.set("actor", { userId: session.userId })
    await next()
  },
)

export type AuthenticatedEnv = {
  Bindings: Env
  Variables: AuthenticatedVariables
}
