import type { NamespaceVerification, NamespaceVerificationSession, VerificationSession } from "../types"

export type SelfVerificationCallbackResponse = {
  result: boolean
  status: VerificationSession["status"]
  id: VerificationSession["id"]
}

// Verification services still assemble contract-shaped resources internally.
// Routes call these serializers so API ownership remains explicit at the edge.
export function serializeVerificationSession(session: VerificationSession): VerificationSession {
  return session
}

export function serializeNamespaceVerificationSession(
  session: NamespaceVerificationSession,
): NamespaceVerificationSession {
  return session
}

export function serializeNamespaceVerification(verification: NamespaceVerification): NamespaceVerification {
  return verification
}

export function serializeSelfVerificationCallbackResponse(
  session: VerificationSession,
): SelfVerificationCallbackResponse {
  return {
    result: session.status === "verified",
    status: session.status,
    id: session.id,
  }
}
