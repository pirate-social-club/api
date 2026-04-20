import { Hono } from "hono"
import { authError, badRequestError, notFoundError } from "../lib/errors"
import { authenticate, authenticateOptional } from "../lib/auth-middleware"
import { getControlPlaneAgentOwnershipRepository } from "../lib/agents/control-plane-agent-ownership-repository"
import type {
  AgentChallenge,
  AgentOwnershipProvider,
  AgentOwnershipSessionKind,
} from "../lib/agents/types"
import type { Env } from "../types"

const agents = new Hono<{ Bindings: Env }>()

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
  const body = (await c.req.json<{
    provider_payload_ref?: string | null
  }>().catch(() => null)) ?? null
  const repo = getControlPlaneAgentOwnershipRepository(c.env)
  const connectionToken = c.req.header("x-agent-connection-token")?.trim() ?? null
  const session = actor?.userId
    ? await repo.completeAgentOwnershipSession({
      agentOwnershipSessionId: c.req.param("agentOwnershipSessionId"),
      userId: actor.userId,
      providerPayloadRef: body?.provider_payload_ref ?? null,
    })
    : connectionToken
      ? await repo.completeAgentOwnershipSessionWithConnectionToken({
        agentOwnershipSessionId: c.req.param("agentOwnershipSessionId"),
        connectionToken,
        providerPayloadRef: body?.provider_payload_ref ?? null,
      })
      : (() => {
        throw authError("Authentication failed")
      })()
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

agents.post("/agents/:agentId/credential", authenticateOptional, async (c) => {
  const actor = c.get("actor")
  const body = (await c.req.json<{
    current_ownership_record_id?: string | null
  }>().catch(() => null)) ?? null
  const repo = getControlPlaneAgentOwnershipRepository(c.env)
  const connectionToken = c.req.header("x-agent-connection-token")?.trim() ?? null
  const credential = actor?.userId
    ? await repo.issueAgentDelegatedCredential({
      agentId: c.req.param("agentId"),
      userId: actor.userId,
      currentOwnershipRecordId: body?.current_ownership_record_id ?? null,
    })
    : connectionToken
      ? await repo.issueAgentDelegatedCredentialWithConnectionToken({
        agentId: c.req.param("agentId"),
        connectionToken,
        currentOwnershipRecordId: body?.current_ownership_record_id ?? null,
      })
      : (() => {
        throw authError("Authentication failed")
      })()
  return c.json(credential, 200)
})

agents.post("/agents/:agentId/credential/refresh", authenticateOptional, async (c) => {
  const actor = c.get("actor")
  const body = await c.req.json<{
    refresh_token?: string
  }>().catch(() => null)
  if (!body?.refresh_token) {
    throw badRequestError("refresh_token is required")
  }
  const repo = getControlPlaneAgentOwnershipRepository(c.env)
  const connectionToken = c.req.header("x-agent-connection-token")?.trim() ?? null
  const credential = actor?.userId
    ? await repo.refreshAgentDelegatedCredential({
      agentId: c.req.param("agentId"),
      userId: actor.userId,
      refreshToken: body.refresh_token,
    })
    : connectionToken
      ? await repo.refreshAgentDelegatedCredentialWithConnectionToken({
        agentId: c.req.param("agentId"),
        connectionToken,
        refreshToken: body.refresh_token,
      })
      : (() => {
        throw authError("Authentication failed")
      })()
  return c.json(credential, 200)
})

export default agents
