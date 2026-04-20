import type { DbExecutor } from "../db-helpers"
import type { Client, Transaction } from "../sql-client"
import { firstRow } from "../auth/auth-db-query-helpers"
import { getUserRow } from "../auth/auth-db-user-queries"
import { parseVerificationCapabilities } from "../auth/auth-serializers"
import { authError, badRequestError, conflictError, eligibilityFailed, internalError, notFoundError, notImplementedError, verificationRequired } from "../errors"
import { makeId, nowIso } from "../helpers"
import { sha256Hex } from "../crypto"
import type { Env } from "../../types"
import type {
  AgentDelegatedCredential,
  AgentChallenge,
  AgentOwnershipPairing,
  AgentOwnershipPairingClaimResult,
  AgentOwnershipSession,
  AgentOwnershipSessionLaunch,
  UserAgent,
} from "./types"
import {
  type AgentDelegatedCredentialRow,
  type AgentPairingCodeRow,
  type AgentOwnershipRecordRow,
  type AgentOwnershipSessionRow,
  type UserAgentRow,
  toAgentPairingCodeRow,
  toAgentDelegatedCredentialRow,
  toAgentOwnershipRecordRow,
  toAgentOwnershipSessionRow,
  toUserAgentRow,
} from "./agent-db-rows"
import {
  parseAgentChallenge,
  serializeAgentOwnershipRecord,
  serializeAgentOwnershipSession,
  serializeUserAgent,
} from "./agent-serializers"
import { assertVerifiedAgentChallenge, normalizeClawkeyPublicKeyToPem } from "./agent-challenge"
import {
  assertAgentOwnershipRecordStateTransition,
  assertAgentOwnershipSessionStatusTransition,
  assertUserAgentStatusTransition,
} from "./agent-ownership-state-machine"
import { getClawkeyProvider } from "./clawkey-provider"

const AGENT_ACCESS_TOKEN_TTL_MS = 15 * 60 * 1000
const AGENT_REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000
const AGENT_PAIRING_CODE_TTL_MS = 10 * 60 * 1000
const AGENT_PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

function isTerminalStatus(status: AgentOwnershipSession["status"]): boolean {
  return status === "verified" || status === "failed" || status === "expired" || status === "cancelled"
}

async function updateAgentOwnershipSessionStatus(
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

async function getAgentOwnershipSessionRowForUser(
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

async function getAgentOwnershipSessionRowById(
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

async function getAgentPairingCodeRowByCode(
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

async function getAgentPairingCodeRowByConnectionTokenHash(
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

async function getUserAgentRowForOwner(
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

async function getUserAgentRowById(executor: DbExecutor, agentId: string): Promise<UserAgentRow | null> {
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

async function getCurrentOwnershipRecordRowForAgent(
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

async function listUserAgentRowsForOwner(executor: DbExecutor, ownerUserId: string): Promise<UserAgentRow[]> {
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

async function countActiveUserAgentsForOwner(executor: DbExecutor, ownerUserId: string): Promise<number> {
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

async function getAgentDelegatedCredentialRowByRefreshToken(
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

async function getAgentDelegatedCredentialRowByAccessTokenHash(
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

function assertRegisterOnly(sessionKind: string): asserts sessionKind is "register" {
  if (sessionKind !== "register") {
    throw notImplementedError("Only register agent ownership sessions are implemented in this slice")
  }
}

function assertClawkeyOnly(provider: string): asserts provider is "clawkey" {
  if (provider !== "clawkey") {
    throw notImplementedError("Only the clawkey ownership provider is implemented in this slice")
  }
}

async function ensureEligibleOwner(client: Client, userId: string): Promise<void> {
  const userRow = await getUserRow(client, userId)
  if (!userRow) {
    throw internalError("User row is missing")
  }
  const capabilities = parseVerificationCapabilities(userRow.verification_capabilities_json)
  if (capabilities.unique_human.state !== "verified") {
    throw verificationRequired("unique_human verification is required before starting agent ownership")
  }
}

async function ensureEligibleOwnerCanRegisterAgent(client: Client, userId: string): Promise<void> {
  await ensureEligibleOwner(client, userId)
  const activeAgentCount = await countActiveUserAgentsForOwner(client, userId)
  if (activeAgentCount >= 1) {
    throw conflictError("Public v0 allows only one active user-owned agent per verified human")
  }
}

function buildLaunch(input: {
  clawkeyRegistration: NonNullable<AgentOwnershipSessionLaunch["clawkey_registration"]>
}): AgentOwnershipSessionLaunch {
  return {
    mode: "registration_url",
    clawkey_registration: input.clawkeyRegistration,
  }
}

function defaultAgentDisplayName(agentId: string): string {
  return `Agent ${agentId.slice(-6)}`
}

function deriveEvidenceRef(providerSessionRef: string | null, registeredAt?: string | null): string | null {
  if (typeof registeredAt === "string" && registeredAt.trim()) {
    return registeredAt.trim()
  }
  return providerSessionRef
}

function buildOpaqueToken(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "")}`
}

function buildPairingCodeSegment(length: number): string {
  const randomBytes = crypto.getRandomValues(new Uint8Array(length))
  let output = ""
  for (let index = 0; index < length; index += 1) {
    output += AGENT_PAIRING_CODE_ALPHABET[randomBytes[index]! % AGENT_PAIRING_CODE_ALPHABET.length]
  }
  return output
}

function buildPairingCode(): string {
  return `PIR-${buildPairingCodeSegment(4)}-${buildPairingCodeSegment(4)}`
}

function plusMs(baseMs: number, deltaMs: number): string {
  return new Date(baseMs + deltaMs).toISOString()
}

function serializeDelegatedCredential(input: {
  row: AgentDelegatedCredentialRow
  accessToken: string
  refreshToken: string
}): AgentDelegatedCredential {
  return {
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

  const displayName = sessionRow.display_name?.trim() || defaultAgentDisplayName(agentId)
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

export async function createAgentOwnershipPairingCode(
  client: Client,
  input: {
    userId: string
  },
): Promise<AgentOwnershipPairing> {
  await ensureEligibleOwnerCanRegisterAgent(client, input.userId)

  let pairingCode = ""
  let existing: AgentPairingCodeRow | null = null
  for (let attempt = 0; attempt < 5; attempt += 1) {
    pairingCode = buildPairingCode()
    existing = await getAgentPairingCodeRowByCode(client, pairingCode)
    if (!existing) {
      break
    }
  }

  if (existing) {
    throw internalError("Could not generate a unique agent pairing code")
  }

  const createdAt = nowIso()
  const expiresAt = plusMs(Date.now(), AGENT_PAIRING_CODE_TTL_MS)
  await client.execute({
    sql: `
      INSERT INTO agent_pairing_codes (
        code, user_id, status, claimed_at, connection_token_hash,
        agent_ownership_session_id, expires_at, created_at
      ) VALUES (?1, ?2, 'pending', NULL, NULL, NULL, ?3, ?4)
    `,
    args: [pairingCode, input.userId, expiresAt, createdAt],
  })

  return {
    pairing_code: pairingCode,
    expires_at: expiresAt,
  }
}

export async function claimAgentOwnershipPairingCode(
  client: Client,
  env: Env,
  input: {
    pairingCode: string
    agentChallenge: AgentChallenge
  },
): Promise<AgentOwnershipPairingClaimResult> {
  const pairingCode = input.pairingCode.trim().toUpperCase()
  if (!pairingCode) {
    throw badRequestError("pairing_code is required")
  }

  const pairingRow = await getAgentPairingCodeRowByCode(client, pairingCode)
  if (!pairingRow) {
    throw notFoundError("Pairing code not found")
  }
  if (pairingRow.status !== "pending") {
    throw conflictError("Pairing code is no longer available")
  }
  if (new Date(pairingRow.expires_at).getTime() <= Date.now()) {
    await client.execute({
      sql: `
        UPDATE agent_pairing_codes
        SET status = 'expired'
        WHERE code = ?1
      `,
      args: [pairingCode],
    })
    throw conflictError("Pairing code has expired")
  }

  const startedSession = await startAgentOwnershipSession(client, env, {
    userId: pairingRow.user_id,
    sessionKind: "register",
    ownershipProvider: "clawkey",
    agentChallenge: input.agentChallenge,
  })

  const registrationUrl = startedSession.launch.clawkey_registration?.registration_url?.trim()
  if (!registrationUrl) {
    throw internalError("Agent ownership session is missing a ClawKey registration URL")
  }

  const connectionToken = buildOpaqueToken("agpair")
  const connectionTokenHash = await sha256Hex(connectionToken)
  const claimedAt = nowIso()
  await client.execute({
    sql: `
      UPDATE agent_pairing_codes
      SET status = 'claimed',
          claimed_at = ?2,
          connection_token_hash = ?3,
          agent_ownership_session_id = ?4
      WHERE code = ?1
    `,
    args: [
      pairingCode,
      claimedAt,
      connectionTokenHash,
      startedSession.agent_ownership_session_id,
    ],
  })

  return {
    agent_ownership_session_id: startedSession.agent_ownership_session_id,
    registration_url: registrationUrl,
    connection_token: connectionToken,
  }
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

  if (new Date(row.expires_at).getTime() <= Date.now()) {
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
    } catch {}
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

export async function getUserAgent(
  client: Client,
  agentId: string,
  userId: string,
): Promise<UserAgent | null> {
  const row = await getUserAgentRowForOwner(client, agentId, userId)
  if (!row) {
    return null
  }
  const currentOwnershipRow = await getCurrentOwnershipRecordRowForAgent(client, agentId, userId)
  return serializeUserAgent(row, currentOwnershipRow ? serializeAgentOwnershipRecord(currentOwnershipRow) : null)
}

export async function listUserAgents(
  client: Client,
  userId: string,
): Promise<UserAgent[]> {
  const rows = await listUserAgentRowsForOwner(client, userId)
  const items: UserAgent[] = []
  for (const row of rows) {
    const currentOwnershipRow = await getCurrentOwnershipRecordRowForAgent(client, row.agent_id, userId)
    items.push(
      serializeUserAgent(row, currentOwnershipRow ? serializeAgentOwnershipRecord(currentOwnershipRow) : null),
    )
  }
  return items
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

  const refreshExpiresAtMs = existingRow.refresh_expires_at ? new Date(existingRow.refresh_expires_at).getTime() : Number.NaN
  if (Number.isFinite(refreshExpiresAtMs) && refreshExpiresAtMs <= Date.now()) {
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
    } catch {}
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

  const expiresAtMs = new Date(credentialRow.expires_at).getTime()
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
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
