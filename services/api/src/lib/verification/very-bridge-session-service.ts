import type { Client } from "../sql-client"
import { badRequestError } from "../errors"
import { getVerificationSessionRowForUser } from "./verification-shared"

export async function recordVeryBridgeSession(
  client: Client,
  input: {
    verificationSessionId: string
    userId: string
    providerSessionId: string
  },
): Promise<boolean | null> {
  if (!input.providerSessionId.trim() || input.providerSessionId.includes("/")) {
    throw badRequestError("Invalid Very bridge session id")
  }
  const row = await getVerificationSessionRowForUser(client, input.verificationSessionId, input.userId)
  if (!row) {
    return null
  }
  if (row.provider !== "very") {
    throw badRequestError("Verification session is not a Very session")
  }
  if (row.status !== "pending") {
    throw badRequestError("Session is not in a pollable state")
  }

  await client.execute({
    sql: `UPDATE verification_sessions SET upstream_session_ref = ?2, updated_at = ?3 WHERE verification_session_id = ?1`,
    args: [input.verificationSessionId, input.providerSessionId.trim(), new Date().toISOString()],
  })
  return true
}
