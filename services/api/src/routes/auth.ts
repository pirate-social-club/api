import { Hono } from "hono"
import { authError } from "../lib/errors"
import { verifyJwtBasedAuth } from "../lib/auth/jwt-based-auth"
import { verifyStagingTestJwt } from "../lib/auth/staging-test-auth"
import { mintPirateAccessToken } from "../lib/auth/pirate-session-token"
import { verifyPrivyAccessProof } from "../lib/auth/privy-auth"
import { getProfileRepository, getSessionRepository } from "../lib/auth/repositories"
import { trackApiEvent } from "../lib/analytics/track"
import type { Env } from "../env"
import type { SessionExchangeRequest } from "../types"

const auth = new Hono<{ Bindings: Env }>()

auth.post("/session/exchange", async (c) => {
  const body = await c.req.json<SessionExchangeRequest>().catch(() => null)
  if (!body || !body.proof || typeof body.proof !== "object" || !("type" in body.proof)) {
    throw authError("Invalid auth proof payload")
  }

  // Staging-only test issuer (not part of the public SessionExchangeRequest contract).
  // verifyStagingTestJwt fails closed outside ENVIRONMENT=staging, so sending this proof
  // type to prod/dev is rejected even if a secret were present.
  const proof = body.proof as { type?: string; jwt?: string }

  const upstreamIdentity =
    proof.type === "staging_test_jwt"
      ? await verifyStagingTestJwt({ env: c.env, jwt: String(proof.jwt ?? "") })
      : body.proof.type === "jwt_based_auth"
        ? await verifyJwtBasedAuth({ env: c.env, jwt: body.proof.jwt })
        : body.proof.type === "privy_access_token"
          ? await verifyPrivyAccessProof({
              env: c.env,
              accessToken: body.proof.privy_access_token,
              walletAddress: body.proof.wallet_address ?? null,
            })
          : (() => {
              throw authError("Unsupported auth proof type")
            })()

  const repository = getSessionRepository(c.env)
  const session = await repository.exchangeIdentity(upstreamIdentity)
  const userId = session.user.id.replace(/^usr_/, "")
  const syncedProfile = await getProfileRepository(c.env)
    .syncLinkedHandles(userId)
    .catch(() => null)
  const accessToken = await mintPirateAccessToken({
    env: c.env,
    userId,
  })
  if (body.proof.type === "jwt_based_auth") {
    await trackApiEvent(c.env, c.req, {
      eventName: "auth_started",
      userId,
      properties: { provider: "jwt_based_auth" },
    })
  }
  await trackApiEvent(c.env, c.req, {
    eventName: "auth_session_exchanged",
    userId,
    properties: { provider: upstreamIdentity.provider },
  })

  return c.json(
    {
      access_token: accessToken,
      ...session,
      profile: syncedProfile ?? session.profile,
    },
    200,
  )
})

export default auth
