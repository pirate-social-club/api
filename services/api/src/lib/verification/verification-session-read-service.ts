import type { Client } from "../sql-client"
import { serializeVerificationSession } from "../auth/auth-serializers"
import type { VerificationSession } from "../../types"
import {
  getAttestationsBySourceSessionId,
  getVerificationSessionRowForUser,
} from "./verification-shared"

export async function getVerificationSession(
  client: Client,
  verificationSessionId: string,
  userId: string,
): Promise<VerificationSession | null> {
  const row = await getVerificationSessionRowForUser(client, verificationSessionId, userId)
  if (!row) {
    return null
  }
  const attestationRows = await getAttestationsBySourceSessionId(client, verificationSessionId, userId)
  return serializeVerificationSession({ row, attestationRows })
}
