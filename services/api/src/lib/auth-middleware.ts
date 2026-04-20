import { createMiddleware } from "hono/factory"
import { authError } from "./errors"
import { getControlPlaneAgentOwnershipRepository } from "./agents/control-plane-agent-ownership-repository"
import { verifyPirateAccessToken } from "./auth/pirate-session-token"
import type { Env } from "../types"

export type ActorContext = {
  userId: string
  authType: "user" | "agent_delegated"
  delegatedAgentId?: string
  delegatedCredentialOwnershipRecordId?: string
}

type AuthenticatedVariables = {
  actor: ActorContext
}

export function requireBearerToken(headerValue: string | undefined): string {
  if (!headerValue || !headerValue.startsWith("Bearer ")) {
    throw authError("Authentication failed")
  }
  return headerValue.slice("Bearer ".length)
}

export async function authenticateUserToken(input: {
  env: Env
  token: string
}): Promise<ActorContext> {
  const session = await verifyPirateAccessToken({ env: input.env, token: input.token })
  return {
    userId: session.userId,
    authType: "user",
  }
}

export async function authenticateAgentDelegatedToken(input: {
  env: Env
  token: string
}): Promise<ActorContext> {
  const session = await getControlPlaneAgentOwnershipRepository(input.env).verifyAgentDelegatedAccessToken({
    accessToken: input.token,
  })
  return {
    userId: session.userId,
    authType: "agent_delegated",
    delegatedAgentId: session.agentId,
    delegatedCredentialOwnershipRecordId: session.currentOwnershipRecordId,
  }
}

export const authenticate = createMiddleware<{ Bindings: Env; Variables: AuthenticatedVariables }>(
  async (c, next) => {
    const token = requireBearerToken(c.req.header("authorization"))
    c.set("actor", await authenticateUserToken({ env: c.env, token }))
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
    c.set("actor", await authenticateUserToken({ env: c.env, token }))
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
