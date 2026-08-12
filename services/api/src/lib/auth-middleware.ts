import { createHash, timingSafeEqual } from "node:crypto"
import { createMiddleware } from "hono/factory"
import { AuthenticationFailureError, authError, eligibilityFailed } from "./errors"
import { getControlPlaneAgentOwnershipRepository } from "./agents/agent-ownership-repository"
import { getUserRepository } from "./auth/repositories"
import { DEFAULT_PIRATE_APP_SCOPE, verifyPirateAccessToken } from "./auth/pirate-session-token"
import { resolveCanonicalUserId } from "./auth/account-alias-service"
import type { Env } from "../env"
import {
  ADMIN_USERS_ACT_AS_SCOPE,
  authenticateOperatorCredential,
  requireOperatorScope,
  type OperatorScope,
} from "./operator-credential-auth"

export type ActorContext = {
  userId: string
  authType: "user" | "agent_delegated" | "device"
  delegatedAgentId?: string
  delegatedCredentialOwnershipRecordId?: string
  scope?: string
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
  const user = await getUserRepository(input.env).getUserById(session.userId)
  if (!user) {
    throw authError("Authentication failed")
  }
  const userId = await resolveCanonicalUserId({ env: input.env, userId: session.userId })

  return {
    userId,
    authType: session.scope === DEFAULT_PIRATE_APP_SCOPE ? "user" : "device",
    scope: session.scope,
  }
}

async function authenticateAgentDelegatedToken(input: {
  env: Env
  token: string
}): Promise<ActorContext> {
  const session = await getControlPlaneAgentOwnershipRepository(input.env).verifyAgentDelegatedAccessToken({
    accessToken: input.token,
  })
  const userId = await resolveCanonicalUserId({ env: input.env, userId: session.userId })
  return {
    userId,
    authType: "agent_delegated",
    delegatedAgentId: session.agentId,
    delegatedCredentialOwnershipRecordId: session.currentOwnershipRecordId,
  }
}

export function requireScope(actor: ActorContext | AdminActorContext, requiredScope: string): void {
  if (actor.authType === "admin" || actor.authType !== "device") {
    return
  }
  const scopes = new Set((actor.scope || "").split(/\s+/).filter(Boolean))
  if (!scopes.has(requiredScope)) {
    throw eligibilityFailed("Insufficient OAuth scope", { required_scope: requiredScope })
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

export async function authenticateAdminAccessOnly(input: {
  env: Env
  authorization: string | undefined
  legacyToken: string | undefined
  requiredScope: OperatorScope
}): Promise<AdminActorContext["adminOverride"] | null> {
  if (input.env.ENVIRONMENT === "production" && String(input.env.PIRATE_ADMIN_TOKEN || "").trim()) {
    console.error("[admin-auth] deprecated production shared token remains configured", {
      code: "legacy_admin_token_configured_in_production",
      removal_after: "2026-10-01",
    })
  }
  if (input.authorization?.startsWith("Operator ")) {
    const operator = await authenticateOperatorCredential({
      env: input.env,
      authorization: input.authorization,
    })
    requireOperatorScope(operator, input.requiredScope)
    return {
      adminActorId: operator.operatorActorId,
      scope: input.requiredScope,
    }
  }

  // TODO(security-deprecation-2026-10-01): remove the shared-token fallback
  // after production telemetry confirms zero legacy requests.
  const legacy = authenticateAdminTokenOnly({ env: input.env, token: input.legacyToken })
  if (legacy) {
    const production = input.env.ENVIRONMENT === "production"
    console[production ? "error" : "warn"]("[admin-auth] legacy shared token used", {
      code: "legacy_admin_token_used",
      environment: input.env.ENVIRONMENT ?? "unknown",
      removal_after: "2026-10-01",
    })
  }
  return legacy
}

export async function authenticateAdminAccess(input: {
  env: Env
  authorization: string | undefined
  legacyToken: string | undefined
  asUserId: string | undefined
}): Promise<AdminActorContext | null> {
  const adminOverride = await authenticateAdminAccessOnly({
    env: input.env,
    authorization: input.authorization,
    legacyToken: input.legacyToken,
    requiredScope: ADMIN_USERS_ACT_AS_SCOPE,
  })
  if (!adminOverride) return null
  const userId = input.asUserId?.trim()
  if (!userId) throw authError("Admin actor user is required")
  return { userId, authType: "admin", adminOverride }
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
  const adminActor = await authenticateAdminAccess({
    env: input.env,
    authorization: input.authorization,
    legacyToken: input.xAdminToken,
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
  } catch (error) {
    if (!(error instanceof AuthenticationFailureError)) {
      throw error
    }
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
    const adminActor = await authenticateAdminAccess({
      env: c.env,
      authorization: c.req.header("authorization"),
      legacyToken: c.req.header("x-admin-token"),
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
