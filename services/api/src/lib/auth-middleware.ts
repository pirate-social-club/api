import { createHash, timingSafeEqual } from "node:crypto"
import { createMiddleware } from "hono/factory"
import { authError } from "./errors"
import { getControlPlaneAgentOwnershipRepository } from "./agents/agent-ownership-repository"
import { verifyPirateAccessToken } from "./auth/pirate-session-token"
import type { Env } from "../env"

export type ActorContext = {
  userId: string
  authType: "user" | "agent_delegated"
  delegatedAgentId?: string
  delegatedCredentialOwnershipRecordId?: string
}

export type AdminActorContext = {
  userId: string
  authType: "admin"
  adminOverride: {
    adminActorId: string
    scope: string
  }
}

type AuthenticatedVariables = {
  actor: ActorContext | AdminActorContext
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

export function authenticateAdminToken(input: {
  env: Env
  token: string | undefined
  asUserId: string | undefined
}): AdminActorContext | null {
  const adminOverride = authenticateAdminTokenOnly({ env: input.env, token: input.token })
  if (!adminOverride) {
    return null
  }

  const asUserId = input.asUserId?.trim()
  if (!asUserId) {
    throw authError("Admin actor user is required")
  }

  return {
    userId: asUserId,
    authType: "admin",
    adminOverride: {
      adminActorId: adminOverride.adminActorId,
      scope: adminOverride.scope,
    },
  }
}

export function authenticateAdminTokenOnly(input: {
  env: Env
  token: string | undefined
}): AdminActorContext["adminOverride"] | null {
  const token = input.token?.trim()
  if (!token) {
    return null
  }

  const configured = String(input.env.PIRATE_ADMIN_TOKEN || "").trim()
  if (!configured || !timingSafeTokenEqual(token, configured)) {
    throw authError("Authentication failed")
  }

  return {
    adminActorId: "admin-token",
    scope: "full",
  }
}

function timingSafeTokenEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest()
  const rightDigest = createHash("sha256").update(right).digest()
  return timingSafeEqual(leftDigest, rightDigest)
}

export async function authenticateAdminUserOrAgentDelegated(input: {
  allowAgentDelegated: boolean
  authorization: string | undefined
  env: Env
  xAdminAsUserId: string | undefined
  xAdminToken: string | undefined
}): Promise<ActorContext | AdminActorContext> {
  const adminActor = authenticateAdminToken({
    env: input.env,
    token: input.xAdminToken,
    asUserId: input.xAdminAsUserId,
  })
  if (adminActor) {
    return adminActor
  }

  const token = requireBearerToken(input.authorization)
  if (!input.allowAgentDelegated) {
    return authenticateUserToken({ env: input.env, token })
  }

  try {
    return await authenticateUserToken({ env: input.env, token })
  } catch {
    return authenticateAgentDelegatedToken({ env: input.env, token })
  }
}

export const authenticate = createMiddleware<{ Bindings: Env; Variables: AuthenticatedVariables }>(
  async (c, next) => {
    const token = requireBearerToken(c.req.header("authorization"))
    c.set("actor", await authenticateUserToken({ env: c.env, token }))
    await next()
  },
)

export const authenticateAdminOrUser = createMiddleware<{ Bindings: Env; Variables: AuthenticatedVariables }>(
  async (c, next) => {
    const adminActor = authenticateAdminToken({
      env: c.env,
      token: c.req.header("x-admin-token"),
      asUserId: c.req.header("x-admin-as-user-id"),
    })
    if (adminActor) {
      c.set("actor", adminActor)
      await next()
      return
    }

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
