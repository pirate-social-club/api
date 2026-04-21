import type { DbExecutor } from "../db-helpers"
import { firstRow, hasUniqueConstraintField } from "../auth/auth-db-query-helpers"
import { internalError } from "../errors"
import { makeId, nowIso } from "../helpers"
import type { AgentOwnershipSession } from "./types"
import {
  type AgentHandleRow,
  type AgentDelegatedCredentialRow,
  type AgentPairingCodeRow,
  type AgentOwnershipRecordRow,
  type AgentOwnershipSessionRow,
  type UserAgentRow,
  toAgentPairingCodeRow,
  toAgentDelegatedCredentialRow,
  toAgentOwnershipRecordRow,
  toAgentOwnershipSessionRow,
  toAgentHandleRow,
  toUserAgentRow,
} from "./agent-db-rows"
import {
  formatAgentHandleLabel,
  isReservedAgentHandleLabel,
  slugifyAgentHandleCandidate,
} from "./agent-handle-policy"
import { assertAgentOwnershipSessionStatusTransition } from "./agent-ownership-state-machine"

export async function updateAgentOwnershipSessionStatus(
  executor: DbExecutor,
  input: {
    row: AgentOwnershipSessionRow
    nextStatus: AgentOwnershipSession["status"]
    updatedAt: string
    failureReason?: string | null
  },
): Promise<void> {
  assertAgentOwnershipSessionStatusTransition(input.row.status, input.nextStatus)
  await executor.execute({
    sql: `
      UPDATE agent_ownership_sessions
      SET status = ?2,
          failure_reason = ?3,
          updated_at = ?4
      WHERE agent_ownership_session_id = ?1
    `,
    args: [
      input.row.agent_ownership_session_id,
      input.nextStatus,
      input.failureReason ?? null,
      input.updatedAt,
    ],
  })
}

export async function getAgentOwnershipSessionRowForUser(
  executor: DbExecutor,
  agentOwnershipSessionId: string,
  userId: string,
): Promise<AgentOwnershipSessionRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT agent_ownership_session_id, session_kind, owner_user_id, agent_id, display_name, policy_id,
             ownership_provider, status, agent_challenge_ref, agent_challenge_payload_json,
             provider_session_ref, launch_json, callback_path, resolved_agent_ownership_record_id,
             failure_reason, created_at, expires_at, updated_at
      FROM agent_ownership_sessions
      WHERE agent_ownership_session_id = ?1
        AND owner_user_id = ?2
      LIMIT 1
    `,
    args: [agentOwnershipSessionId, userId],
  })

  return row ? toAgentOwnershipSessionRow(row) : null
}

export async function getAgentOwnershipSessionRowById(
  executor: DbExecutor,
  agentOwnershipSessionId: string,
): Promise<AgentOwnershipSessionRow | null> {
  // This lookup is intentionally unscoped for provider callbacks.
  // Callers must enforce non-user auth before mutating the resolved session.
  const row = await firstRow(executor, {
    sql: `
      SELECT agent_ownership_session_id, session_kind, owner_user_id, agent_id, display_name, policy_id,
             ownership_provider, status, agent_challenge_ref, agent_challenge_payload_json,
             provider_session_ref, launch_json, callback_path, resolved_agent_ownership_record_id,
             failure_reason, created_at, expires_at, updated_at
      FROM agent_ownership_sessions
      WHERE agent_ownership_session_id = ?1
      LIMIT 1
    `,
    args: [agentOwnershipSessionId],
  })

  return row ? toAgentOwnershipSessionRow(row) : null
}

export async function getAgentPairingCodeRowByCode(
  executor: DbExecutor,
  pairingCode: string,
): Promise<AgentPairingCodeRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT code, user_id, status, claimed_at, connection_token_hash,
             agent_ownership_session_id, expires_at, created_at
      FROM agent_pairing_codes
      WHERE code = ?1
      LIMIT 1
    `,
    args: [pairingCode],
  })

  return row ? toAgentPairingCodeRow(row) : null
}

export async function getAgentPairingCodeRowByConnectionTokenHash(
  executor: DbExecutor,
  connectionTokenHash: string,
): Promise<AgentPairingCodeRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT code, user_id, status, claimed_at, connection_token_hash,
             agent_ownership_session_id, expires_at, created_at
      FROM agent_pairing_codes
      WHERE connection_token_hash = ?1
      LIMIT 1
    `,
    args: [connectionTokenHash],
  })

  return row ? toAgentPairingCodeRow(row) : null
}

export async function getUserAgentRowForOwner(
  executor: DbExecutor,
  agentId: string,
  ownerUserId: string,
): Promise<UserAgentRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT agent_id, owner_user_id, display_name, status, created_at, updated_at
      FROM user_agents
      WHERE agent_id = ?1
        AND owner_user_id = ?2
      LIMIT 1
    `,
    args: [agentId, ownerUserId],
  })

  return row ? toUserAgentRow(row) : null
}

export async function getUserAgentRowById(executor: DbExecutor, agentId: string): Promise<UserAgentRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT agent_id, owner_user_id, display_name, status, created_at, updated_at
      FROM user_agents
      WHERE agent_id = ?1
      LIMIT 1
    `,
    args: [agentId],
  })

  return row ? toUserAgentRow(row) : null
}

export function isAgentHandleLabelUniqueError(error: unknown): boolean {
  return hasUniqueConstraintField(error, "agent_handles.label_normalized")
    || hasUniqueConstraintField(error, "label_normalized")
}

export function isAgentHandleAgentUniqueError(error: unknown): boolean {
  return hasUniqueConstraintField(error, "agent_handles.agent_id")
    || hasUniqueConstraintField(error, "agent_id")
}

export async function getActiveAgentHandleRow(
  executor: DbExecutor,
  agentId: string,
): Promise<AgentHandleRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT agent_handle_id, agent_id, label_normalized, label_display, status,
             redirect_target_agent_handle_id, issued_at, replaced_at, created_at, updated_at
      FROM agent_handles
      WHERE agent_id = ?1
        AND status = 'active'
      LIMIT 1
    `,
    args: [agentId],
  })

  return row ? toAgentHandleRow(row) : null
}

export async function getAgentHandleRowByLabel(
  executor: DbExecutor,
  labelNormalized: string,
): Promise<AgentHandleRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT agent_handle_id, agent_id, label_normalized, label_display, status,
             redirect_target_agent_handle_id, issued_at, replaced_at, created_at, updated_at
      FROM agent_handles
      WHERE label_normalized = ?1
        AND status IN ('active', 'redirect')
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC
      LIMIT 1
    `,
    args: [labelNormalized],
  })

  return row ? toAgentHandleRow(row) : null
}

export async function getAgentHandleRowById(
  executor: DbExecutor,
  agentHandleId: string,
): Promise<AgentHandleRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT agent_handle_id, agent_id, label_normalized, label_display, status,
             redirect_target_agent_handle_id, issued_at, replaced_at, created_at, updated_at
      FROM agent_handles
      WHERE agent_handle_id = ?1
      LIMIT 1
    `,
    args: [agentHandleId],
  })

  return row ? toAgentHandleRow(row) : null
}

export async function allocateInitialAgentHandle(
  executor: DbExecutor,
  input: {
    agentId: string
    displayName: string
    createdAt: string
  },
): Promise<AgentHandleRow | null> {
  const baseCandidate = slugifyAgentHandleCandidate(input.displayName)
  if (!baseCandidate || isReservedAgentHandleLabel(baseCandidate)) {
    return null
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const labelNormalized = attempt === 0
      ? baseCandidate
      : `${baseCandidate}-${input.agentId.slice(-4 - attempt).replace(/[^a-z0-9]/giu, "") || attempt}`
    try {
      await executor.execute({
        sql: `
          INSERT INTO agent_handles (
            agent_handle_id, agent_id, label_normalized, label_display, status,
            redirect_target_agent_handle_id, issued_at, replaced_at, created_at, updated_at
          ) VALUES (?1, ?2, ?3, ?4, 'active', NULL, ?5, NULL, ?5, ?5)
        `,
          args: [
            makeId("agh"),
            input.agentId,
            labelNormalized,
            formatAgentHandleLabel(labelNormalized),
            input.createdAt,
          ],
        })
      return await getActiveAgentHandleRow(executor, input.agentId)
    } catch (error) {
      if (!isAgentHandleLabelUniqueError(error)) {
        throw error
      }
    }
  }

  return null
}

export async function getCurrentOwnershipRecordRowForAgent(
  executor: DbExecutor,
  agentId: string,
  ownerUserId?: string | null,
): Promise<AgentOwnershipRecordRow | null> {
  const now = nowIso()
  const row = await firstRow(executor, {
    sql: `
      SELECT agent_ownership_record_id, agent_id, owner_user_id, ownership_provider, provider_subject_id,
             device_id, public_key, ownership_state, source_session_id, verified_at, expires_at,
             ended_at, evidence_ref, created_at, updated_at
      FROM agent_ownership_records
      WHERE agent_id = ?1
        ${ownerUserId ? "AND owner_user_id = ?2" : ""}
        AND ownership_state = 'verified'
        AND ended_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?${ownerUserId ? "3" : "2"})
      ORDER BY COALESCE(verified_at, created_at) DESC
      LIMIT 1
    `,
    args: ownerUserId ? [agentId, ownerUserId, now] : [agentId, now],
  })

  return row ? toAgentOwnershipRecordRow(row) : null
}

export async function listUserAgentRowsForOwner(executor: DbExecutor, ownerUserId: string): Promise<UserAgentRow[]> {
  const result = await executor.execute({
    sql: `
      SELECT agent_id, owner_user_id, display_name, status, created_at, updated_at
      FROM user_agents
      WHERE owner_user_id = ?1
      ORDER BY created_at DESC
    `,
    args: [ownerUserId],
  })
  return result.rows.map(toUserAgentRow)
}

export async function countActiveUserAgentsForOwner(executor: DbExecutor, ownerUserId: string): Promise<number> {
  const row = await firstRow(executor, {
    sql: `
      SELECT COUNT(*) AS count
      FROM user_agents
      WHERE owner_user_id = ?1
        AND status = 'active'
    `,
    args: [ownerUserId],
  })

  if (!row || typeof row !== "object" || row == null || !("count" in row)) {
    throw internalError("Active agent count query failed")
  }

  const count = Number((row as { count: unknown }).count)
  return Number.isFinite(count) ? count : 0
}

export async function getAgentDelegatedCredentialRowByRefreshToken(
  executor: DbExecutor,
  input: {
    agentId: string
    ownerUserId: string
    refreshTokenHash: string
  },
): Promise<AgentDelegatedCredentialRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT agent_delegated_credential_id, agent_id, owner_user_id, agent_ownership_record_id,
             access_token_hash, refresh_token_hash, status, issued_at, expires_at, refresh_expires_at,
             superseded_by_credential_id, refreshed_from_credential_id, invalidated_at, created_at, updated_at
      FROM agent_delegated_credentials
      WHERE agent_id = ?1
        AND owner_user_id = ?2
        AND refresh_token_hash = ?3
      LIMIT 1
    `,
    args: [input.agentId, input.ownerUserId, input.refreshTokenHash],
  })

  return row ? toAgentDelegatedCredentialRow(row) : null
}

export async function getAgentDelegatedCredentialRowByAccessTokenHash(
  executor: DbExecutor,
  accessTokenHash: string,
): Promise<AgentDelegatedCredentialRow | null> {
  const row = await firstRow(executor, {
    sql: `
      SELECT agent_delegated_credential_id, agent_id, owner_user_id, agent_ownership_record_id,
             access_token_hash, refresh_token_hash, status, issued_at, expires_at, refresh_expires_at,
             superseded_by_credential_id, refreshed_from_credential_id, invalidated_at, created_at, updated_at
      FROM agent_delegated_credentials
      WHERE access_token_hash = ?1
      LIMIT 1
    `,
    args: [accessTokenHash],
  })

  return row ? toAgentDelegatedCredentialRow(row) : null
}

