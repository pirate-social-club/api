import type { DbExecutor } from "../db-helpers"
import type { Client, Transaction } from "../sql-client"
import { getGlobalHandleRow, getProfileRow, listLinkedHandleRows } from "../auth/auth-db-user-queries"
import { assembleProfile, getProfilePublicHandleStem } from "../auth/auth-serializers"
import { conflictError, internalError, notFoundError, notImplementedError, authError } from "../errors"
import { makeId, nowIso } from "../helpers"
import { sha256Hex } from "../crypto"
import type { Env } from "../../types"
import type {
  AgentChallenge,
  AgentOwnershipSession,
  AgentOwnershipSessionLaunch,
} from "./types"
import type { AgentOwnershipSessionRow } from "./agent-db-rows"
import { parseAgentChallenge, serializeAgentOwnershipSession } from "./agent-serializers"
import { assertVerifiedAgentChallenge, normalizeClawkeyPublicKeyToPem } from "./agent-challenge"
import { resolveRequestedAgentDisplayName } from "./agent-handle-policy"
import {
  assertAgentOwnershipRecordStateTransition,
  assertAgentOwnershipSessionStatusTransition,
  assertUserAgentStatusTransition,
} from "./agent-ownership-state-machine"
import {
  allocateInitialAgentHandle,
  getAgentOwnershipSessionRowById,
  getAgentOwnershipSessionRowForUser,
  getAgentPairingCodeRowByConnectionTokenHash,
  getUserAgentRowById,
  updateAgentOwnershipSessionStatus,
} from "./agent-ownership-queries"
import {
  assertClawkeyOnly,
  assertRegisterOnly,
  ensureEligibleOwnerCanRegisterAgent,
} from "./agent-ownership-eligibility"
import {
  parseIsoMs,
} from "./agent-token-policy"
import { getClawkeyProvider } from "./clawkey-provider"

function isTerminalStatus(status: AgentOwnershipSession["status"]): boolean {
  return status === "verified" || status === "failed" || status === "expired" || status === "cancelled"
}

function buildLaunch(input: {
  clawkeyRegistration: NonNullable<AgentOwnershipSessionLaunch["clawkey_registration"]>
}): AgentOwnershipSessionLaunch {
  return {
    mode: "registration_url",
    clawkey_registration: input.clawkeyRegistration,
  }
}

async function getOwnerAgentDisplayNameFallback(
  executor: DbExecutor,
  ownerUserId: string,
  agentId: string,
): Promise<string> {
  const profileRow = await getProfileRow(executor, ownerUserId)
  if (profileRow) {
    const globalHandleRow = await getGlobalHandleRow(executor, profileRow.global_handle_id)
    const linkedHandleRows = await listLinkedHandleRows(executor, ownerUserId)
    const ownerProfile = globalHandleRow ? assembleProfile(profileRow, globalHandleRow, linkedHandleRows) : null
    const ownerHandleLabel = ownerProfile ? getProfilePublicHandleStem(ownerProfile) : null
    if (ownerHandleLabel) {
      return `${ownerHandleLabel} Agent`
    }
  }
  return `Agent ${agentId.slice(-6)}`
}

function deriveEvidenceRef(providerSessionRef: string | null, registeredAt?: string | null): string | null {
  if (typeof registeredAt === "string" && registeredAt.trim()) {
    return registeredAt.trim()
  }
  return providerSessionRef
}

async function createVerifiedAgentOwnership(
  tx: Transaction,
  sessionRow: AgentOwnershipSessionRow,
  completionData: {
    deviceId?: string | null
    publicKey?: string | null
    registeredAt?: string | null
  },
): Promise<{ agentId: string; ownershipRecordId: string }> {
  if (!sessionRow.owner_user_id) {
    throw internalError("Agent ownership session is missing an owner")
  }
  const challenge = parseAgentChallenge(sessionRow.agent_challenge_payload_json)
  const createdAt = nowIso()
  const agentId = sessionRow.agent_id ?? makeId("agt")
  const existingAgent = await getUserAgentRowById(tx, agentId)
  if (existingAgent) {
    throw conflictError("Agent already exists")
  }

  const displayName = resolveRequestedAgentDisplayName(sessionRow.display_name)
    ?? await getOwnerAgentDisplayNameFallback(tx, sessionRow.owner_user_id, agentId)
  const ownershipRecordId = makeId("aor")
  assertUserAgentStatusTransition(null, "active")
  assertAgentOwnershipRecordStateTransition(null, "verified")
  assertAgentOwnershipSessionStatusTransition(sessionRow.status, "verified")

  await tx.execute({
    sql: `
      INSERT INTO user_agents (
        agent_id, owner_user_id, display_name, status, created_at, updated_at
      ) VALUES (?1, ?2, ?3, 'active', ?4, ?4)
    `,
    args: [agentId, sessionRow.owner_user_id, displayName, createdAt],
  })

  await allocateInitialAgentHandle(tx, {
    agentId,
    displayName,
    createdAt,
  })

  await tx.execute({
    sql: `
      INSERT INTO agent_ownership_records (
        agent_ownership_record_id, agent_id, owner_user_id, ownership_provider, provider_subject_id,
        device_id, public_key, ownership_state, source_session_id, verified_at, expires_at, ended_at,
        evidence_ref, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'verified', ?8, ?9, NULL, NULL, ?10, ?9, ?9)
    `,
    args: [
      ownershipRecordId,
      agentId,
      sessionRow.owner_user_id,
      sessionRow.ownership_provider,
      null,
      completionData.deviceId?.trim() || challenge.device_id.trim(),
      normalizeClawkeyPublicKeyToPem(completionData.publicKey?.trim() || challenge.public_key.trim()),
      sessionRow.agent_ownership_session_id,
      completionData.registeredAt?.trim() || createdAt,
      deriveEvidenceRef(sessionRow.provider_session_ref, completionData.registeredAt ?? null),
    ],
  })

  await tx.execute({
    sql: `
      UPDATE agent_ownership_sessions
      SET agent_id = ?2,
          status = 'verified',
          resolved_agent_ownership_record_id = ?3,
          updated_at = ?4
      WHERE agent_ownership_session_id = ?1
    `,
    args: [sessionRow.agent_ownership_session_id, agentId, ownershipRecordId, createdAt],
  })

  return { agentId, ownershipRecordId }
}

export async function startAgentOwnershipSession(
  client: Client,
  env: Env,
  input: {
    userId: string
    sessionKind: AgentOwnershipSession["session_kind"]
    ownershipProvider: AgentOwnershipSession["ownership_provider"]
    agentId?: string | null
    displayName?: string | null
    policyId?: string | null
    agentChallenge: AgentChallenge
  },
): Promise<AgentOwnershipSession> {
  assertRegisterOnly(input.sessionKind)
  assertClawkeyOnly(input.ownershipProvider)
  assertVerifiedAgentChallenge(input.agentChallenge)
  await ensureEligibleOwnerCanRegisterAgent(client, input.userId)

  if (input.agentId) {
    const existingAgent = await getUserAgentRowById(client, input.agentId)
    if (existingAgent) {
      throw conflictError("Agent already exists")
    }
  }

  const provider = getClawkeyProvider(env)
  const started = await provider.startRegistration({
    deviceId: input.agentChallenge.device_id.trim(),
    publicKey: input.agentChallenge.public_key.trim(),
    message: input.agentChallenge.message.trim(),
    signature: input.agentChallenge.signature.trim(),
    timestamp: input.agentChallenge.timestamp,
  })

  const createdAt = nowIso()
  const expiresAt = started.expiresAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
  const agentOwnershipSessionId = makeId("aos")
  const challengePayloadJson = JSON.stringify({
    device_id: input.agentChallenge.device_id.trim(),
    public_key: input.agentChallenge.public_key.trim(),
    message: input.agentChallenge.message.trim(),
    signature: input.agentChallenge.signature.trim(),
    timestamp: input.agentChallenge.timestamp,
  })
  const agentChallengeRef = `ach_${await sha256Hex(challengePayloadJson)}`
  const launch = buildLaunch({
    clawkeyRegistration: {
      session_id: started.sessionId,
      registration_url: started.registrationUrl,
      expires_at: started.expiresAt,
    },
  })
  assertAgentOwnershipSessionStatusTransition(null, "awaiting_owner")

  await client.execute({
    sql: `
      INSERT INTO agent_ownership_sessions (
        agent_ownership_session_id, session_kind, owner_user_id, agent_id, display_name, policy_id,
        ownership_provider, status, agent_challenge_ref, agent_challenge_payload_json,
        provider_session_ref, launch_json, callback_path, resolved_agent_ownership_record_id,
        failure_reason, created_at, expires_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'awaiting_owner', ?8, ?9, ?10, ?11, ?12, NULL, NULL, ?13, ?14, ?13)
    `,
    args: [
      agentOwnershipSessionId,
      input.sessionKind,
      input.userId,
      input.agentId ?? null,
      input.displayName?.trim() || null,
      input.policyId ?? null,
      input.ownershipProvider,
      agentChallengeRef,
      challengePayloadJson,
      started.sessionId,
      JSON.stringify(launch),
      null,
      createdAt,
      expiresAt,
    ],
  })

  const row = await getAgentOwnershipSessionRowForUser(client, agentOwnershipSessionId, input.userId)
  if (!row) {
    throw internalError("Agent ownership session row is missing after creation")
  }
  return serializeAgentOwnershipSession(row)
}

export async function getAgentOwnershipSession(
  client: Client,
  agentOwnershipSessionId: string,
  userId: string,
): Promise<AgentOwnershipSession | null> {
  const row = await getAgentOwnershipSessionRowForUser(client, agentOwnershipSessionId, userId)
  return row ? serializeAgentOwnershipSession(row) : null
}

export async function completeAgentOwnershipSession(
  client: Client,
  env: Env,
  input: {
    agentOwnershipSessionId: string
    userId: string
    providerPayloadRef?: string | null
  },
): Promise<AgentOwnershipSession | null> {
  const row = await getAgentOwnershipSessionRowForUser(client, input.agentOwnershipSessionId, input.userId)
  if (!row) {
    return null
  }

  if (isTerminalStatus(row.status)) {
    return serializeAgentOwnershipSession(row)
  }

  assertRegisterOnly(row.session_kind)
  assertClawkeyOnly(row.ownership_provider)

  const sessionExpiresAtMs = parseIsoMs(row.expires_at)
  if (sessionExpiresAtMs == null || sessionExpiresAtMs <= Date.now()) {
    const updatedAt = nowIso()
    await updateAgentOwnershipSessionStatus(client, {
      row,
      nextStatus: "expired",
      failureReason: "session_expired",
      updatedAt,
    })
    return await getAgentOwnershipSession(client, input.agentOwnershipSessionId, input.userId)
  }

  if (!row.provider_session_ref) {
    throw internalError("Agent ownership session has no provider session reference")
  }
  const provider = getClawkeyProvider(env)
  const providerOutcome = await provider.getRegistrationStatus({
    sessionId: row.provider_session_ref,
  })

  if (providerOutcome.status === "pending") {
    return await getAgentOwnershipSession(client, input.agentOwnershipSessionId, input.userId)
  }

  if (providerOutcome.status === "failed") {
    await updateAgentOwnershipSessionStatus(client, {
      row,
      nextStatus: "failed",
      failureReason: "provider_failed",
      updatedAt: nowIso(),
    })
    return await getAgentOwnershipSession(client, input.agentOwnershipSessionId, input.userId)
  }

  if (providerOutcome.status === "expired") {
    await updateAgentOwnershipSessionStatus(client, {
      row,
      nextStatus: "expired",
      failureReason: "provider_expired",
      updatedAt: nowIso(),
    })
    return await getAgentOwnershipSession(client, input.agentOwnershipSessionId, input.userId)
  }

  const tx = await client.transaction()
  try {
    const currentRow = await getAgentOwnershipSessionRowForUser(tx, input.agentOwnershipSessionId, input.userId)
    if (!currentRow) {
      throw notFoundError("Agent ownership session not found")
    }
    if (isTerminalStatus(currentRow.status)) {
      await tx.rollback()
      tx.close()
      return serializeAgentOwnershipSession(currentRow)
    }

    await createVerifiedAgentOwnership(tx, currentRow, {
      deviceId: providerOutcome.deviceId,
      publicKey: providerOutcome.publicKey,
      registeredAt: providerOutcome.registeredAt,
    })
    await tx.commit()
    tx.close()
  } catch (error) {
    try {
      await tx.rollback()
    } catch (rollbackError) {
      console.error("[agent-ownership] rollback failed while completing ownership session", rollbackError)
    }
    tx.close()
    throw error
  }

  return await getAgentOwnershipSession(client, input.agentOwnershipSessionId, input.userId)
}

export async function completeAgentOwnershipSessionWithConnectionToken(
  client: Client,
  env: Env,
  input: {
    agentOwnershipSessionId: string
    connectionToken: string
    providerPayloadRef?: string | null
  },
): Promise<AgentOwnershipSession | null> {
  const connectionToken = input.connectionToken.trim()
  if (!connectionToken) {
    throw authError("Authentication failed")
  }

  const connectionTokenHash = await sha256Hex(connectionToken)
  const pairingRow = await getAgentPairingCodeRowByConnectionTokenHash(client, connectionTokenHash)
  if (!pairingRow || !pairingRow.agent_ownership_session_id) {
    throw authError("Authentication failed")
  }
  if (pairingRow.agent_ownership_session_id !== input.agentOwnershipSessionId) {
    throw authError("Authentication failed")
  }
  if (pairingRow.status !== "claimed" && pairingRow.status !== "completed") {
    throw authError("Authentication failed")
  }

  const result = await completeAgentOwnershipSession(client, env, {
    agentOwnershipSessionId: input.agentOwnershipSessionId,
    userId: pairingRow.user_id,
    providerPayloadRef: input.providerPayloadRef ?? null,
  })

  if (!result) {
    return null
  }

  if (result.status === "verified" && pairingRow.status !== "completed") {
    await client.execute({
      sql: `
        UPDATE agent_pairing_codes
        SET status = 'completed'
        WHERE code = ?1
      `,
      args: [pairingRow.code],
    })
  } else if (result.status === "expired") {
    await client.execute({
      sql: `
        UPDATE agent_pairing_codes
        SET status = 'expired'
        WHERE code = ?1
      `,
      args: [pairingRow.code],
    })
  }

  return result
}

export async function completeAgentOwnershipSessionFromCallback(
  client: Client,
  _env: Env,
  input: {
    agentOwnershipSessionId: string
    provider: AgentOwnershipSession["ownership_provider"] | null
    attestationId?: string | null
    proofHash?: string | null
    payload?: Record<string, unknown> | null
    callbackSecret: string | null
  },
): Promise<AgentOwnershipSession | null> {
  const row = await getAgentOwnershipSessionRowById(client, input.agentOwnershipSessionId)
  if (!row) {
    return null
  }

  assertClawkeyOnly(row.ownership_provider)
  throw notImplementedError("ClawKey ownership sessions currently use polling completion, not callbacks")
}
