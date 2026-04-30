import type { Client } from "../sql-client"
import { badRequestError, conflictError, internalError, notFoundError } from "../errors"
import { nowIso } from "../helpers"
import { sha256Hex } from "../crypto"
import type { Env } from "../../env"
import type { AgentChallenge, AgentOwnershipPairing, AgentOwnershipPairingClaimResult } from "./types"
import type { AgentPairingCodeRow } from "./agent-db-rows"
import {
  getAgentPairingCodeRowByCode,
} from "./agent-ownership-queries"
import { ensureEligibleOwnerCanRegisterAgent } from "./agent-ownership-eligibility"
import {
  AGENT_PAIRING_CODE_TTL_MS,
  buildOpaqueToken,
  buildPairingCode,
  parseIsoMs,
  plusMs,
} from "./agent-token-policy"
import { startAgentOwnershipSession } from "./agent-ownership-session-service"

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
  const pairingExpiresAtMs = parseIsoMs(pairingRow.expires_at)
  if (pairingExpiresAtMs == null || pairingExpiresAtMs <= Date.now()) {
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

