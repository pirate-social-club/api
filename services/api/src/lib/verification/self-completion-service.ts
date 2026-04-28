import type { Client } from "../sql-client"
import { badRequestError, providerUnavailable } from "../errors"
import { serializeVerificationSession } from "../auth/auth-serializers"
import type { VerificationSessionRow } from "../auth/auth-db-rows"
import type { SelfSessionOutcome } from "./self-provider"
import { getSelfProvider } from "./self-provider"
import type {
  Env,
  RequestedVerificationCapability,
  VerificationSession,
} from "../../types"
import {
  getVerificationSessionRow,
  getVerificationSessionRowForUser,
} from "./verification-shared"
import { parseVerificationRequirements } from "./verification-requirements"
import { finalizeVerification } from "./verification-finalization-service"

export async function completeSelfSession(
  client: Client,
  env: Env,
  row: VerificationSessionRow,
  input: {
    verificationSessionId: string
    userId: string
    attestationId?: string | null
    proof?: unknown
    proofHash?: string | null
    providerPayloadRef?: unknown
  },
): Promise<VerificationSession> {
  const sessionExpiresAt = row.expires_at
  if (sessionExpiresAt && new Date(sessionExpiresAt) < new Date()) {
    await client.execute({
      sql: `UPDATE verification_sessions SET status = 'expired', updated_at = ?2 WHERE verification_session_id = ?1`,
      args: [input.verificationSessionId, new Date().toISOString()],
    })
    const updatedRow = await getVerificationSessionRowForUser(client, input.verificationSessionId, input.userId)
    return serializeVerificationSession({ row: updatedRow!, attestationRows: [] })
  }

  let outcome: SelfSessionOutcome
  try {
    const provider = getSelfProvider(env)
    outcome = await provider.getSessionOutcome({
      upstreamSessionRef: row.upstream_session_ref ?? input.verificationSessionId,
      attestationId: input.attestationId ?? null,
      proof: input.proof ?? null,
      providerPayloadRef: input.providerPayloadRef ?? null,
    })
  } catch (error) {
    throw providerUnavailable(
      error instanceof Error ? error.message : "Self provider is unavailable"
    )
  }

  if (outcome.status === "verified") {
    const requestedCapabilities = JSON.parse(row.requested_capabilities_json) as RequestedVerificationCapability[]
    const verificationRequirements = parseVerificationRequirements(row.verification_requirements_json)
    const missingClaims: string[] = []
    if (requestedCapabilities.includes("age_over_18") && outcome.claims.age_over_18 !== true) {
      missingClaims.push("age_over_18")
    }
    for (const requirement of verificationRequirements) {
      const minimumAge = requirement.minimum_age
      if (
        requirement.proof_type === "minimum_age"
        && typeof minimumAge === "number"
        && Number.isInteger(minimumAge)
        && (outcome.claims.minimum_age == null || outcome.claims.minimum_age < minimumAge)
      ) {
        missingClaims.push(`minimum_age:${minimumAge}`)
      }
    }
    if (requestedCapabilities.includes("nationality") && !outcome.claims.nationality) {
      missingClaims.push("nationality")
    }
    if (requestedCapabilities.includes("gender") && !outcome.claims.gender) {
      missingClaims.push("gender")
    }
    if (missingClaims.length > 0) {
      const updatedAt = new Date().toISOString()
      await client.execute({
        sql: `UPDATE verification_sessions SET status = 'failed', failure_code = ?2, updated_at = ?3 WHERE verification_session_id = ?1`,
        args: [input.verificationSessionId, `missing_required_claims:${missingClaims.join(",")}`, updatedAt],
      })
      const updatedRow = await getVerificationSessionRowForUser(client, input.verificationSessionId, input.userId)
      return serializeVerificationSession({ row: updatedRow!, attestationRows: [] })
    }
    return finalizeVerification(client, row, input, requestedCapabilities, verificationRequirements, outcome.claims)
  }

  if (outcome.status === "pending") {
    return serializeVerificationSession({ row, attestationRows: [] })
  }

  if (outcome.status === "failed") {
    const updatedAt = new Date().toISOString()
    await client.execute({
      sql: `UPDATE verification_sessions SET status = 'failed', failure_code = ?2, updated_at = ?3 WHERE verification_session_id = ?1`,
      args: [input.verificationSessionId, outcome.failureReason, updatedAt],
    })
    const updatedRow = await getVerificationSessionRowForUser(client, input.verificationSessionId, input.userId)
    return serializeVerificationSession({ row: updatedRow!, attestationRows: [] })
  }

  if (outcome.status === "expired") {
    const updatedAt = new Date().toISOString()
    await client.execute({
      sql: `UPDATE verification_sessions SET status = 'expired', failure_code = 'provider_expired', updated_at = ?2 WHERE verification_session_id = ?1`,
      args: [input.verificationSessionId, updatedAt],
    })
    const updatedRow = await getVerificationSessionRowForUser(client, input.verificationSessionId, input.userId)
    return serializeVerificationSession({ row: updatedRow!, attestationRows: [] })
  }

  return serializeVerificationSession({ row, attestationRows: [] })
}

export async function completeSelfVerificationCallback(
  client: Client,
  env: Env,
  input: {
    verificationSessionId: string
    payload: Record<string, unknown>
  },
): Promise<VerificationSession | null> {
  const row = await getVerificationSessionRow(client, input.verificationSessionId)
  if (!row) {
    return null
  }
  if (row.provider !== "self") {
    throw badRequestError("Verification session is not a Self session")
  }
  const providerPayload = input.payload.payload != null
    && typeof input.payload.payload === "object"
    && !Array.isArray(input.payload.payload)
    ? input.payload.payload as Record<string, unknown>
    : input.payload
  return completeSelfSession(client, env, row, {
    verificationSessionId: input.verificationSessionId,
    userId: row.user_id,
    attestationId: typeof providerPayload.attestationId === "string"
      ? providerPayload.attestationId
      : typeof providerPayload.attestation_id === "string"
        ? providerPayload.attestation_id
        : null,
    proof: null,
    proofHash: null,
    providerPayloadRef: JSON.stringify(providerPayload),
  })
}
