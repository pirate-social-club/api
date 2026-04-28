import type { Client } from "../sql-client"
import { internalError, providerUnavailable } from "../errors"
import { serializeVerificationSession } from "../auth/auth-serializers"
import type { VerificationSessionRow } from "../auth/auth-db-rows"
import type { VerySessionOutcome } from "./very-provider"
import {
  buildVerySessionBinding,
  getVeryProvider,
} from "./very-provider"
import type { Env, VerificationSession } from "../../types"
import { getVerificationSessionRowForUser } from "./verification-shared"
import { finalizeVerification } from "./verification-finalization-service"

function providerErrorDetails(error: unknown): Record<string, unknown> | null {
  if (!(error instanceof Error)) {
    return null
  }
  const details = (error as Error & { details?: unknown }).details
  if (details && typeof details === "object" && !Array.isArray(details)) {
    return details as Record<string, unknown>
  }
  return null
}

export async function completeVerySession(
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
  if (!row.upstream_session_ref) {
    throw internalError("Very session has no upstream reference")
  }

  const sessionExpiresAt = row.expires_at
  if (sessionExpiresAt && new Date(sessionExpiresAt) < new Date()) {
    await client.execute({
      sql: `UPDATE verification_sessions SET status = 'expired', updated_at = ?2 WHERE verification_session_id = ?1`,
      args: [input.verificationSessionId, new Date().toISOString()],
    })
    const updatedRow = await getVerificationSessionRowForUser(client, input.verificationSessionId, input.userId)
    return serializeVerificationSession({ row: updatedRow!, attestationRows: [] })
  }

  let outcome: VerySessionOutcome
  try {
    const provider = getVeryProvider(env)
    const providerPayloadRef = typeof input.providerPayloadRef === "string"
      ? input.providerPayloadRef
      : typeof input.proof === "string"
        ? input.proof
        : null
    outcome = await provider.getSessionOutcome({
      upstreamSessionRef: row.upstream_session_ref,
      providerPayloadRef,
      expectedBinding: buildVerySessionBinding({
        verificationSessionId: input.verificationSessionId,
        challengeExpiresAt: row.expires_at ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      }),
    })
  } catch (error) {
    const details = providerErrorDetails(error)
    throw providerUnavailable(
      error instanceof Error ? error.message : "Very provider is unavailable",
      details,
    )
  }

  if (outcome.status === "verified") {
    console.info("[very-provider] completion outcome", {
      verificationSessionId: input.verificationSessionId,
      outcome: outcome.status,
    })
    return finalizeVerification(client, row, input, null, null, null, outcome.attestationData)
  }

  if (outcome.status === "pending") {
    console.info("[very-provider] completion outcome", {
      verificationSessionId: input.verificationSessionId,
      outcome: outcome.status,
    })
    return serializeVerificationSession({ row, attestationRows: [] })
  }

  if (outcome.status === "failed") {
    console.warn("[very-provider] completion outcome", {
      verificationSessionId: input.verificationSessionId,
      outcome: outcome.status,
      failureReason: outcome.failureReason,
    })
    const updatedAt = new Date().toISOString()
    await client.execute({
      sql: `UPDATE verification_sessions SET status = 'failed', failure_code = ?2, updated_at = ?3 WHERE verification_session_id = ?1`,
      args: [input.verificationSessionId, outcome.failureReason, updatedAt],
    })
    const updatedRow = await getVerificationSessionRowForUser(client, input.verificationSessionId, input.userId)
    return serializeVerificationSession({ row: updatedRow!, attestationRows: [] })
  }

  if (outcome.status === "expired") {
    console.warn("[very-provider] completion outcome", {
      verificationSessionId: input.verificationSessionId,
      outcome: outcome.status,
    })
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
