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

export const authenticateOptional = createMiddleware<{ Bindings: Env; Variables: Partial<AuthenticatedVariables> }>(
  async (c, next) => {
    const header = c.req.header("authorization")
    if (!header || !header.startsWith("Bearer ")) {
      await next()
      return
    }

    const token = requireBearerToken(header)
    const session = await verifyPirateAccessToken({ env: c.env, token })
    c.set("actor", { userId: session.userId })
    await next()
  },
)

export type AuthenticatedEnv = {
  Bindings: Env
  Variables: AuthenticatedVariables
}

export type OptionalAuthenticatedEnv = {
  Bindings: Env
  Variables: Partial<AuthenticatedVariables>
}
