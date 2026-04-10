import { Hono } from "hono"
import { authError, errorResponse } from "../lib/errors"
import { verifyJwtBasedAuth } from "../lib/auth/jwt-based-auth"
import { mintPirateAccessToken } from "../lib/auth/pirate-session-token"
import { verifyPrivyAccessProof } from "../lib/auth/privy-auth"
import { getSessionRepository } from "../lib/auth/repositories"
import type { Env, SessionExchangeRequest } from "../types"

const auth = new Hono<{ Bindings: Env }>()

auth.post("/session/exchange", async (c) => {
  try {
    const body = await c.req.json<SessionExchangeRequest>().catch(() => null)
    if (!body || !body.proof || typeof body.proof !== "object" || !("type" in body.proof)) {
      throw authError("Invalid auth proof payload")
    }

    const upstreamIdentity =
      body.proof.type === "jwt_based_auth"
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
    const accessToken = await mintPirateAccessToken({
      env: c.env,
      userId: session.user.user_id,
    })

    return c.json(
      {
        access_token: accessToken,
        ...session,
      },
      200,
    )
  } catch (error) {
    const response = errorResponse(error)
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: {
        "content-type": "application/json",
      },
    })
  }
})

export default auth
