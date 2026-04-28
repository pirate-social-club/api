import type { Client } from "../sql-client"
import { badRequestError, eligibilityFailed } from "../errors"
import { serializeVerificationSession } from "../auth/auth-serializers"
import type { Env, VerificationSession } from "../../types"
import {
  getAttestationsBySourceSessionId,
  getVerificationSessionRowForUser,
} from "./verification-shared"
import { getVerificationSession } from "./verification-session-read-service"
import { finalizeVerification } from "./verification-finalization-service"
import { completeSelfSession } from "./self-completion-service"
import { completeVerySession } from "./very-completion-service"

function isTerminalStatus(status: string): boolean {
  return status === "verified" || status === "failed" || status === "expired"
}

export async function completeVerificationSession(
  client: Client,
  env: Env,
  input: {
    verificationSessionId: string
    userId: string
    attestationId?: string | null
    proof?: unknown
    proofHash?: string | null
    providerPayloadRef?: unknown
  },
): Promise<VerificationSession | null> {
  const row = await getVerificationSessionRowForUser(client, input.verificationSessionId, input.userId)
  if (!row) {
    return null
  }

  if (isTerminalStatus(row.status)) {
    const attestationRows = await getAttestationsBySourceSessionId(client, input.verificationSessionId, input.userId)
    return serializeVerificationSession({ row, attestationRows })
  }

  if (row.status !== "pending") {
    throw badRequestError("Session is not in a pollable state")
  }

  if (row.provider === "very") {
    return completeVerySession(client, env, row, input)
  }

  if (row.provider === "self") {
    return completeSelfSession(client, env, row, input)
  }

  const sessionExpiresAt = row.expires_at
  if (sessionExpiresAt && new Date(sessionExpiresAt) < new Date()) {
    throw eligibilityFailed("Verification session has expired")
  }

  return finalizeVerification(client, row, input)
}

export { getVerificationSession }
