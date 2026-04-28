import { Hono } from "hono"
import { authError, badRequestError, notFoundError } from "../lib/errors"
import { authenticate, authenticateOptional } from "../lib/auth-middleware"
import { getControlPlaneAgentOwnershipRepository } from "../lib/agents/agent-ownership-repository"
import type { ActorContext } from "../lib/auth-middleware"
import type {
  AgentChallenge,
  AgentOwnershipProvider,
  AgentOwnershipSessionKind,
} from "../lib/agents/types"
import type { Env } from "../types"

const agents = new Hono<{ Bindings: Env }>()

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw badRequestError(`Invalid ${field}`)
  }
  return value.trim()
}

async function resolveActorOrConnectionToken<T>(input: {
  actor: ActorContext | undefined
  connectionToken: string | null
  withActor: (userId: string) => Promise<T>
  withConnectionToken: (connectionToken: string) => Promise<T>
}): Promise<T> {
  if (input.actor?.userId) {
    return await input.withActor(input.actor.userId)
  }
  if (input.connectionToken) {
    return await input.withConnectionToken(input.connectionToken)
  }
  throw authError("Authentication failed")
}

agents.post("/agent-ownership-pairing", authenticate, async (c) => {
  const actor = c.get("actor")
  const repo = getControlPlaneAgentOwnershipRepository(c.env)
  const pairing = await repo.createAgentOwnershipPairingCode({
    userId: actor.userId,
  })
  return c.json(pairing, 201)
})

agents.post("/agent-ownership-pairing/claim", async (c) => {
  const body = await c.req.json<{
    pairing_code?: string | null
    agent_challenge?: AgentChallenge | null
  }>().catch(() => null)

  if (!body?.pairing_code || !body.agent_challenge) {
    throw badRequestError("Invalid agent ownership pairing claim payload")
  }

  const repo = getControlPlaneAgentOwnershipRepository(c.env)
  const claimed = await repo.claimAgentOwnershipPairingCode({
    pairingCode: body.pairing_code,
    agentChallenge: body.agent_challenge,
  })
  return c.json(claimed, 200)
})

agents.post("/agent-ownership-sessions", authenticate, async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{
    session_kind?: AgentOwnershipSessionKind
    ownership_provider?: AgentOwnershipProvider
    agent_id?: string | null
    display_name?: string | null
    policy_id?: string | null
    agent_challenge?: AgentChallenge | null
  }>().catch(() => null)

  if (!body?.session_kind || !body.ownership_provider || !body.agent_challenge) {
    throw badRequestError("Invalid agent ownership session payload")
  }

  const repo = getControlPlaneAgentOwnershipRepository(c.env)
  const created = await repo.startAgentOwnershipSession({
    userId: actor.userId,
    sessionKind: body.session_kind,
    ownershipProvider: body.ownership_provider,
    agentId: body.agent_id ?? null,
    displayName: body.display_name ?? null,
    policyId: body.policy_id ?? null,
    agentChallenge: body.agent_challenge,
  })
  return c.json(created, 201)
})

agents.get("/agent-ownership-sessions/:agentOwnershipSessionId", authenticate, async (c) => {
  const actor = c.get("actor")
  const repo = getControlPlaneAgentOwnershipRepository(c.env)
  const session = await repo.getAgentOwnershipSession(c.req.param("agentOwnershipSessionId"), actor.userId)
  if (!session) {
    throw notFoundError("Agent ownership session not found")
  }
  return c.json(session, 200)
})

agents.post("/agent-ownership-sessions/:agentOwnershipSessionId/complete", authenticateOptional, async (c) => {
  const actor = c.get("actor")
  const userActor = actor?.authType === "admin" ? undefined : actor
  const body = (await c.req.json<{
    provider_payload_ref?: string | null
  }>().catch(() => null)) ?? null
  const repo = getControlPlaneAgentOwnershipRepository(c.env)
  const connectionToken = c.req.header("x-agent-connection-token")?.trim() ?? null
  const agentOwnershipSessionId = c.req.param("agentOwnershipSessionId")
  const session = await resolveActorOrConnectionToken({
    actor: userActor,
    connectionToken,
    withActor: (userId) => repo.completeAgentOwnershipSession({
      agentOwnershipSessionId,
      userId,
      providerPayloadRef: body?.provider_payload_ref ?? null,
    }),
    withConnectionToken: (token) => repo.completeAgentOwnershipSessionWithConnectionToken({
      agentOwnershipSessionId,
      connectionToken: token,
      providerPayloadRef: body?.provider_payload_ref ?? null,
    }),
  })
  if (!session) {
    throw notFoundError("Agent ownership session not found")
  }
  return c.json(session, 200)
})
agents.post("/agent-ownership-sessions/:agentOwnershipSessionId/callback", async (c) => {
  const body = (await c.req.json<{
    provider?: AgentOwnershipProvider | null
    event_type?: string | null
    attestation_id?: string | null
    proof_hash?: string | null
    payload?: Record<string, unknown> | null
  }>().catch(() => null)) ?? null

  const repo = getControlPlaneAgentOwnershipRepository(c.env)
  const session = await repo.completeAgentOwnershipSessionFromCallback({
    agentOwnershipSessionId: c.req.param("agentOwnershipSessionId"),
    provider: body?.provider ?? null,
    attestationId: body?.attestation_id ?? null,
    proofHash: body?.proof_hash ?? null,
    payload: body?.payload ?? null,
    callbackSecret: c.req.header("x-very-callback-secret")?.trim() ?? null,
  })
  if (!session) {
    throw notFoundError("Agent ownership session not found")
  }
  return c.json(session, 200)
})

agents.get("/agents", authenticate, async (c) => {
  const actor = c.get("actor")
  const repo = getControlPlaneAgentOwnershipRepository(c.env)
  const items = await repo.listUserAgents(actor.userId)
  return c.json({ items }, 200)
})

agents.get("/agents/:agentId", authenticate, async (c) => {
  const actor = c.get("actor")
  const repo = getControlPlaneAgentOwnershipRepository(c.env)
  const agent = await repo.getUserAgent(c.req.param("agentId"), actor.userId)
  if (!agent) {
    throw notFoundError("Agent not found")
  }
  return c.json(agent, 200)
})

agents.patch("/agents/:agentId", authenticate, async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ display_name?: unknown }>().catch(() => null)
  if (!body || typeof body !== "object") {
    throw badRequestError("Invalid agent update payload")
  }

  const repo = getControlPlaneAgentOwnershipRepository(c.env)
  const agent = await repo.updateUserAgentDisplayName({
    agentId: c.req.param("agentId"),
    userId: actor.userId,
    displayName: requireString(body.display_name, "display_name"),
  })
  if (!agent) {
    throw notFoundError("Agent not found")
  }
  return c.json(agent, 200)
})

agents.get("/agents/:agentId/handle", authenticate, async (c) => {
  const actor = c.get("actor")
  const repo = getControlPlaneAgentOwnershipRepository(c.env)
  const handle = await repo.getUserAgentHandle({
    agentId: c.req.param("agentId"),
    userId: actor.userId,
  })
  if (!handle) {
    const agent = await repo.getUserAgent(c.req.param("agentId"), actor.userId)
    if (!agent) {
      throw notFoundError("Agent not found")
    }
    throw notFoundError("Agent handle not found")
  }
  return c.json(handle, 200)
})

agents.post("/agents/:agentId/handle", authenticate, async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{ desired_label?: unknown }>().catch(() => null)
  if (!body || typeof body !== "object") {
    throw badRequestError("Invalid agent handle payload")
  }

  const repo = getControlPlaneAgentOwnershipRepository(c.env)
  const handle = await repo.claimUserAgentHandle({
    agentId: c.req.param("agentId"),
    userId: actor.userId,
    desiredLabel: requireString(body.desired_label, "desired_label"),
  })
  if (!handle) {
    throw notFoundError("Agent not found")
  }
  return c.json(handle, 200)
})

agents.post("/agents/:agentId/credential", authenticateOptional, async (c) => {
  const actor = c.get("actor")
  const userActor = actor?.authType === "admin" ? undefined : actor
  const body = (await c.req.json<{
    current_ownership_record_id?: string | null
  }>().catch(() => null)) ?? null
  const repo = getControlPlaneAgentOwnershipRepository(c.env)
  const connectionToken = c.req.header("x-agent-connection-token")?.trim() ?? null
  const agentId = c.req.param("agentId")
  const credential = await resolveActorOrConnectionToken({
    actor: userActor,
    connectionToken,
    withActor: (userId) => repo.issueAgentDelegatedCredential({
      agentId,
      userId,
      currentOwnershipRecordId: body?.current_ownership_record_id ?? null,
    }),
    withConnectionToken: (token) => repo.issueAgentDelegatedCredentialWithConnectionToken({
      agentId,
      connectionToken: token,
      currentOwnershipRecordId: body?.current_ownership_record_id ?? null,
    }),
  })
  return c.json(credential, 200)
})

agents.post("/agents/:agentId/credential/refresh", authenticateOptional, async (c) => {
  const actor = c.get("actor")
  const userActor = actor?.authType === "admin" ? undefined : actor
  const body = await c.req.json<{
    refresh_token?: string
  }>().catch(() => null)
  if (!body?.refresh_token) {
    throw badRequestError("refresh_token is required")
  }
  const refreshToken = body.refresh_token
  const repo = getControlPlaneAgentOwnershipRepository(c.env)
  const connectionToken = c.req.header("x-agent-connection-token")?.trim() ?? null
  const agentId = c.req.param("agentId")
  const credential = await resolveActorOrConnectionToken({
    actor: userActor,
    connectionToken,
    withActor: (userId) => repo.refreshAgentDelegatedCredential({
      agentId,
      userId,
      refreshToken,
    }),
    withConnectionToken: (token) => repo.refreshAgentDelegatedCredentialWithConnectionToken({
      agentId,
      connectionToken: token,
      refreshToken,
    }),
  })
  return c.json(credential, 200)
})

export default agents
