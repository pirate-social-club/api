import { jwtVerify } from "jose"
import { authError } from "../errors"
import { envFlag, splitCsv } from "../helpers"
import type { Env, UpstreamIdentity } from "../../types"

const encoder = new TextEncoder()

export async function verifyJwtBasedAuth(params: {
  env: Env
  jwt: string
}): Promise<UpstreamIdentity> {
  if (!envFlag(params.env.JWT_BASED_AUTH_ENABLED, false)) {
    throw authError("jwt_based_auth is disabled")
  }

  const sharedSecret = String(params.env.AUTH_UPSTREAM_JWT_SHARED_SECRET || params.env.JWT_BASED_AUTH_SHARED_SECRET || "").trim()
  if (!sharedSecret) {
    throw authError("AUTH_UPSTREAM_JWT_SHARED_SECRET is not configured")
  }

  const issuers = splitCsv(
    params.env.AUTH_UPSTREAM_JWT_ISSUER
      ? params.env.AUTH_UPSTREAM_JWT_ISSUER
      : params.env.JWT_BASED_AUTH_ISSUERS,
  )
  if (issuers.length === 0) {
    throw authError("AUTH_UPSTREAM_JWT_ISSUER is not configured")
  }

  const audience = String(params.env.AUTH_UPSTREAM_JWT_AUDIENCE || params.env.JWT_BASED_AUTH_AUDIENCE || "").trim() || undefined
  const verification = await jwtVerify(params.jwt, encoder.encode(sharedSecret), {
    issuer: issuers,
    ...(audience ? { audience } : {}),
  }).catch(() => {
    throw authError("Authentication failed")
  })

  const subject = typeof verification.payload.sub === "string" ? verification.payload.sub.trim() : ""
  const issuer = typeof verification.payload.iss === "string" ? verification.payload.iss.trim() : ""
  if (!subject || !issuer) {
    throw authError("JWT is missing required subject or issuer")
  }

  return {
    provider: "jwt",
    providerSubject: `${issuer}|${subject}`,
    providerUserRef: subject,
    // The first executable slice does not persist wallet attachments from jwt_based_auth.
    walletAddresses: [],
    selectedWalletAddress: null,
  }
}
