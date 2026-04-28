import { jwtVerify } from "jose"
import { authError } from "../errors"
import { dedupeStrings, envFlag, normalizeAddress, splitCsv } from "../helpers"
import type { Env, UpstreamIdentity } from "../../types"

const encoder = new TextEncoder()

function walletAddressesFromJwtClaim(value: unknown): string[] {
  if (value == null) {
    return []
  }

  if (Array.isArray(value)) {
    const wallets = value.map((item) => {
      const normalized = normalizeAddress(item)
      if (!normalized) {
        throw authError("JWT wallet claim must contain valid EVM addresses")
      }
      return normalized
    })
    return dedupeStrings(wallets)
  }

  const normalized = normalizeAddress(value)
  if (!normalized) {
    throw authError("JWT wallet claim must be a valid EVM address")
  }
  return [normalized]
}

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

  const walletAddresses = walletAddressesFromJwtClaim(
    verification.payload.wallet_addresses ?? verification.payload.wallet_address,
  )
  const selectedWalletAddress =
    normalizeAddress(verification.payload.selected_wallet_address)
    ?? walletAddresses[0]
    ?? null

  return {
    provider: "jwt",
    providerSubject: `${issuer}|${subject}`,
    providerUserRef: subject,
    walletAddresses,
    selectedWalletAddress,
  }
}
