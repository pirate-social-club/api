import type { Client, Transaction } from "../sql-client"
import { authError, badRequestError, conflictError, eligibilityFailed, notFoundError } from "../errors"
import { makeId, nowIso } from "../helpers"
import { sha256Hex } from "../crypto"
import type { AgentDelegatedCredential } from "./types"
import type { AgentDelegatedCredentialRow, AgentOwnershipRecordRow, UserAgentRow } from "./agent-db-rows"
import {
  getAgentDelegatedCredentialRowByAccessTokenHash,
  getAgentDelegatedCredentialRowByRefreshToken,
  getAgentOwnershipSessionRowById,
  getAgentPairingCodeRowByConnectionTokenHash,
  getCurrentOwnershipRecordRowForAgent,
  getUserAgentRowForOwner,
} from "./agent-ownership-queries"
import { ensureEligibleOwner } from "./agent-ownership-eligibility"
import {
  AGENT_ACCESS_TOKEN_TTL_MS,
  AGENT_REFRESH_TOKEN_TTL_MS,
  buildOpaqueToken,
  parseIsoMs,
  plusMs,
} from "./agent-token-policy"

function serializeDelegatedCredential(input: {
  row: AgentDelegatedCredentialRow
  accessToken: string
  refreshToken: string
}): AgentDelegatedCredential {
  return {
    agent_delegated_credential_id: input.row.agent_delegated_credential_id,
    agent_id: input.row.agent_id,
    owner_user_id: input.row.owner_user_id,
    current_ownership_record_id: input.row.agent_ownership_record_id,
    token_type: "Bearer",
    access_token: input.accessToken,
    refresh_token: input.refreshToken,
    issued_at: input.row.issued_at,
    expires_at: input.row.expires_at,
    refresh_expires_at: input.row.refresh_expires_at,
  }
}

async function assertIssuableOwnedAgent(
  client: Client,
  input: {
    agentId: string
    ownerUserId: string
    currentOwnershipRecordId?: string | null
  },
): Promise<{ agentRow: UserAgentRow; ownershipRow: AgentOwnershipRecordRow }> {
  await ensureEligibleOwner(client, input.ownerUserId)
  const agentRow = await getUserAgentRowForOwner(client, input.agentId, input.ownerUserId)
  if (!agentRow) {
    throw notFoundError("Agent not found")
  }
  if (agentRow.status !== "active") {
    throw eligibilityFailed("Agent is not active")
  }

  const ownershipRow = await getCurrentOwnershipRecordRowForAgent(client, input.agentId, input.ownerUserId)
  if (!ownershipRow) {
    throw eligibilityFailed("Agent does not have an active verified ownership interval")
  }
  if (
    input.currentOwnershipRecordId?.trim()
    && input.currentOwnershipRecordId.trim() !== ownershipRow.agent_ownership_record_id
  ) {
    throw conflictError("Ownership interval is no longer current")
  }

  return { agentRow, ownershipRow }
}

async function createDelegatedCredentialRecord(
  executor: Client | Transaction,
  input: {
    agentId: string
    ownerUserId: string
    agentOwnershipRecordId: string
    refreshedFromCredentialId?: string | null
  },
): Promise<{
  row: AgentDelegatedCredentialRow
  accessToken: string
  refreshToken: string
}> {
  const nowMs = Date.now()
  const createdAt = new Date(nowMs).toISOString()
  const accessToken = buildOpaqueToken("agtok")
  const refreshToken = buildOpaqueToken("agrf")
  const accessTokenHash = await sha256Hex(accessToken)
  const refreshTokenHash = await sha256Hex(refreshToken)
  const row: AgentDelegatedCredentialRow = {
    agent_delegated_credential_id: makeId("adc"),
    agent_id: input.agentId,
    owner_user_id: input.ownerUserId,
    agent_ownership_record_id: input.agentOwnershipRecordId,
    access_token_hash: accessTokenHash,
    refresh_token_hash: refreshTokenHash,
    status: "active",
    issued_at: createdAt,
    expires_at: plusMs(nowMs, AGENT_ACCESS_TOKEN_TTL_MS),
    refresh_expires_at: plusMs(nowMs, AGENT_REFRESH_TOKEN_TTL_MS),
    superseded_by_credential_id: null,
    refreshed_from_credential_id: input.refreshedFromCredentialId ?? null,
    invalidated_at: null,
    created_at: createdAt,
    updated_at: createdAt,
  }

  await executor.execute({
    sql: `
      INSERT INTO agent_delegated_credentials (
        agent_delegated_credential_id, agent_id, owner_user_id, agent_ownership_record_id,
        access_token_hash, refresh_token_hash, status, issued_at, expires_at, refresh_expires_at,
        superseded_by_credential_id, refreshed_from_credential_id, invalidated_at, created_at, updated_at
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11, NULL, ?12, ?12)
    `,
    args: [
      row.agent_delegated_credential_id,
      row.agent_id,
      row.owner_user_id,
      row.agent_ownership_record_id,
      row.access_token_hash,
      row.refresh_token_hash,
      row.status,
      row.issued_at,
      row.expires_at,
      row.refresh_expires_at,
      row.refreshed_from_credential_id,
      row.created_at,
    ],
  })

  return { row, accessToken, refreshToken }
}

export async function issueAgentDelegatedCredential(
  client: Client,
  input: {
    agentId: string
    userId: string
    currentOwnershipRecordId?: string | null
  },
): Promise<AgentDelegatedCredential> {
  const { ownershipRow } = await assertIssuableOwnedAgent(client, {
    agentId: input.agentId,
    ownerUserId: input.userId,
    currentOwnershipRecordId: input.currentOwnershipRecordId ?? null,
  })

  const created = await createDelegatedCredentialRecord(client, {
    agentId: input.agentId,
    ownerUserId: input.userId,
    agentOwnershipRecordId: ownershipRow.agent_ownership_record_id,
  })

  return serializeDelegatedCredential(created)
}

async function resolveAgentOwnershipByConnectionToken(
  client: Client,
  input: {
    agentId: string
    connectionToken: string
  },
): Promise<{ userId: string }> {
  const connectionToken = input.connectionToken.trim()
  if (!connectionToken) {
    throw authError("Authentication failed")
  }

  const connectionTokenHash = await sha256Hex(connectionToken)
  const pairingRow = await getAgentPairingCodeRowByConnectionTokenHash(client, connectionTokenHash)
  if (!pairingRow || !pairingRow.agent_ownership_session_id || pairingRow.status !== "completed") {
    throw authError("Authentication failed")
  }

  const sessionRow = await getAgentOwnershipSessionRowById(client, pairingRow.agent_ownership_session_id)
  if (!sessionRow || sessionRow.status !== "verified" || sessionRow.agent_id !== input.agentId) {
    throw authError("Authentication failed")
  }

  return { userId: pairingRow.user_id }
}

export async function issueAgentDelegatedCredentialWithConnectionToken(
  client: Client,
  input: {
    agentId: string
    connectionToken: string
    currentOwnershipRecordId?: string | null
  },
): Promise<AgentDelegatedCredential> {
  const resolved = await resolveAgentOwnershipByConnectionToken(client, {
    agentId: input.agentId,
    connectionToken: input.connectionToken,
  })

  return issueAgentDelegatedCredential(client, {
    agentId: input.agentId,
    userId: resolved.userId,
    currentOwnershipRecordId: input.currentOwnershipRecordId ?? null,
  })
}

export async function refreshAgentDelegatedCredential(
  client: Client,
  input: {
    agentId: string
    userId: string
    refreshToken: string
  },
): Promise<AgentDelegatedCredential> {
  const refreshToken = input.refreshToken.trim()
  if (!refreshToken) {
    throw badRequestError("refresh_token is required")
  }

  const refreshTokenHash = await sha256Hex(refreshToken)
  const existingRow = await getAgentDelegatedCredentialRowByRefreshToken(client, {
    agentId: input.agentId,
    ownerUserId: input.userId,
    refreshTokenHash,
  })
  if (!existingRow) {
    throw notFoundError("Delegated credential not found")
  }
  if (existingRow.status !== "active") {
    throw eligibilityFailed("Delegated credential is no longer active")
  }

  const refreshExpiresAtMs = existingRow.refresh_expires_at ? parseIsoMs(existingRow.refresh_expires_at) : null
  if (refreshExpiresAtMs == null || refreshExpiresAtMs <= Date.now()) {
    await client.execute({
      sql: `
        UPDATE agent_delegated_credentials
        SET status = 'expired',
            invalidated_at = ?2,
            updated_at = ?2
        WHERE agent_delegated_credential_id = ?1
      `,
      args: [existingRow.agent_delegated_credential_id, nowIso()],
    })
    throw eligibilityFailed("Delegated credential refresh token has expired")
  }

  const { ownershipRow } = await assertIssuableOwnedAgent(client, {
    agentId: input.agentId,
    ownerUserId: input.userId,
  })
  if (ownershipRow.agent_ownership_record_id !== existingRow.agent_ownership_record_id) {
    throw eligibilityFailed("Delegated credential ownership interval is no longer active")
  }

  const tx = await client.transaction()
  try {
    const created = await createDelegatedCredentialRecord(tx, {
      agentId: input.agentId,
      ownerUserId: input.userId,
      agentOwnershipRecordId: existingRow.agent_ownership_record_id,
      refreshedFromCredentialId: existingRow.agent_delegated_credential_id,
    })
    await tx.execute({
      sql: `
        UPDATE agent_delegated_credentials
        SET status = 'superseded',
            superseded_by_credential_id = ?2,
            invalidated_at = ?3,
            updated_at = ?3
        WHERE agent_delegated_credential_id = ?1
      `,
      args: [
        existingRow.agent_delegated_credential_id,
        created.row.agent_delegated_credential_id,
        created.row.issued_at,
      ],
    })
    await tx.commit()
    tx.close()
    return serializeDelegatedCredential(created)
  } catch (error) {
    try {
      await tx.rollback()
    } catch (rollbackError) {
      console.error("[agent-credentials] rollback failed while creating delegated credential", rollbackError)
    }
    tx.close()
    throw error
  }
}

export async function refreshAgentDelegatedCredentialWithConnectionToken(
  client: Client,
  input: {
    agentId: string
    connectionToken: string
    refreshToken: string
  },
): Promise<AgentDelegatedCredential> {
  const resolved = await resolveAgentOwnershipByConnectionToken(client, {
    agentId: input.agentId,
    connectionToken: input.connectionToken,
  })

  return refreshAgentDelegatedCredential(client, {
    agentId: input.agentId,
    userId: resolved.userId,
    refreshToken: input.refreshToken,
  })
}

export async function verifyAgentDelegatedAccessToken(
  client: Client,
  input: {
    accessToken: string
  },
): Promise<{
  userId: string
  agentId: string
  currentOwnershipRecordId: string
}> {
  const accessToken = input.accessToken.trim()
  if (!accessToken) {
    throw authError("Authentication failed")
  }

  const accessTokenHash = await sha256Hex(accessToken)
  const credentialRow = await getAgentDelegatedCredentialRowByAccessTokenHash(client, accessTokenHash)
  if (!credentialRow || credentialRow.status !== "active") {
    throw authError("Authentication failed")
  }

  const expiresAtMs = parseIsoMs(credentialRow.expires_at)
  if (expiresAtMs == null || expiresAtMs <= Date.now()) {
    await client.execute({
      sql: `
        UPDATE agent_delegated_credentials
        SET status = 'expired',
            invalidated_at = ?2,
            updated_at = ?2
        WHERE agent_delegated_credential_id = ?1
      `,
      args: [credentialRow.agent_delegated_credential_id, nowIso()],
    })
    throw authError("Authentication failed")
  }

  const { ownershipRow } = await assertIssuableOwnedAgent(client, {
    agentId: credentialRow.agent_id,
    ownerUserId: credentialRow.owner_user_id,
  })
  if (ownershipRow.agent_ownership_record_id !== credentialRow.agent_ownership_record_id) {
    throw authError("Authentication failed")
  }

  return {
    userId: credentialRow.owner_user_id,
    agentId: credentialRow.agent_id,
    currentOwnershipRecordId: credentialRow.agent_ownership_record_id,
  }
}
