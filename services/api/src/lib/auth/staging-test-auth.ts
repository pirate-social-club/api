import { jwtVerify } from "jose"
import { authError } from "../errors"
import { dedupeStrings, envFlag, normalizeAddress } from "../helpers"
import type { Env } from "../../env"
import type { UpstreamIdentity } from "../../types"

const encoder = new TextEncoder()

/**
 * Dedicated, staging-ONLY test issuer for driving authenticated validation (e.g. the
 * Turso→D1 write-cutover pilot) without minting real upstream tokens.
 *
 * Security model (do not weaken):
 *  - Deliberately NOT the real upstream issuer (`pirate-staging-upstream`) and NOT
 *    signed with the real upstream secret. Separate issuer + separate secret name.
 *  - Fails closed: only active when ENVIRONMENT=staging AND STAGING_TEST_AUTH_ENABLED
 *    is opted in AND STAGING_TEST_JWT_SHARED_SECRET is set. If the secret somehow
 *    reaches prod/dev, the environment + flag guards still reject every token.
 *  - Verification lives only in the session-exchange path; minting lives in operator
 *    tooling (scripts/mint-staging-test-token.ts), never in a request handler.
 */
export const STAGING_TEST_JWT_ISSUER = "pirate-staging-test-issuer"
export const STAGING_TEST_JWT_AUDIENCE = "pirate-api-staging-test"

/** True only when the staging test issuer is fully enabled in this environment. */
export function stagingTestAuthAvailable(env: Env): boolean {
  return (
    String(env.ENVIRONMENT || "").trim().toLowerCase() === "staging" &&
    envFlag(env.STAGING_TEST_AUTH_ENABLED, false) &&
    Boolean(String(env.STAGING_TEST_JWT_SHARED_SECRET || "").trim())
  )
}

function walletAddressesFromClaim(value: unknown): string[] {
  const items = Array.isArray(value) ? value : value == null ? [] : [value]
  const normalized = items
    .map((item) => normalizeAddress(item))
    .filter((item): item is string => Boolean(item))
  return dedupeStrings(normalized)
}

export async function verifyStagingTestJwt(params: { env: Env; jwt: string }): Promise<UpstreamIdentity> {
  // Fail-closed guards — order matters, environment first.
  if (String(params.env.ENVIRONMENT || "").trim().toLowerCase() !== "staging") {
    throw authError("staging_test_auth is not available in this environment")
  }
  if (!envFlag(params.env.STAGING_TEST_AUTH_ENABLED, false)) {
    throw authError("staging_test_auth is disabled")
  }
  const secret = String(params.env.STAGING_TEST_JWT_SHARED_SECRET || "").trim()
  if (!secret) {
    throw authError("STAGING_TEST_JWT_SHARED_SECRET is not configured")
  }

  const verification = await jwtVerify(params.jwt, encoder.encode(secret), {
    issuer: STAGING_TEST_JWT_ISSUER,
    audience: STAGING_TEST_JWT_AUDIENCE,
  }).catch(() => {
    throw authError("Authentication failed")
  })

  const subject = typeof verification.payload.sub === "string" ? verification.payload.sub.trim() : ""
  if (!subject) {
    throw authError("Staging test JWT is missing required subject")
  }

  const walletAddresses = walletAddressesFromClaim(
    verification.payload.wallet_addresses ?? verification.payload.wallet_address,
  )

  return {
    // Namespaced under the test issuer so the exchanged identity maps to a distinct
    // test user, never colliding with real upstream subjects.
    provider: "jwt",
    providerSubject: `${STAGING_TEST_JWT_ISSUER}|${subject}`,
    providerUserRef: subject,
    walletAddresses,
    selectedWalletAddress: walletAddresses[0] ?? null,
  }
}
