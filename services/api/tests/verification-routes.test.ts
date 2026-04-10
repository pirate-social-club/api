import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../src/index"
import { json, mintUpstreamJwt, createRouteTestContext, resetRuntimeCaches } from "./helpers"
import type { Env } from "../src/types"

let cleanup: (() => Promise<void>) | null = null

function requestJson(url: string, body: unknown, env: Env, token?: string): Promise<Response> {
  return Promise.resolve(app.request(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    },
    env,
  ))
}

async function exchangeJwt(env: Env, sub: string): Promise<{ accessToken: string; userId: string }> {
  const jwt = await mintUpstreamJwt(env, { sub })
  const response = await requestJson("http://pirate.test/auth/session/exchange", {
    proof: {
      type: "jwt_based_auth",
      jwt,
    },
  }, env)
  const body = await json(response) as { access_token: string; user: { user_id: string } }
  return {
    accessToken: body.access_token,
    userId: body.user.user_id,
  }
}

beforeEach(() => {
  resetRuntimeCaches()
})

afterEach(async () => {
  if (cleanup) {
    await cleanup()
    cleanup = null
  }
})

describe("verification routes", () => {
  test("verification and namespace endpoints work through the full route stack", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-user")

    const createdVerification = await requestJson("http://pirate.test/verification-sessions", {
      provider: "self",
    }, ctx.env, session.accessToken)
    expect(createdVerification.status).toBe(201)
    const verificationBody = await json(createdVerification) as {
      verification_session_id: string
      status: string
    }
    expect(verificationBody.status).toBe("pending")

    const fetchedVerification = await app.request(
      `http://pirate.test/verification-sessions/${verificationBody.verification_session_id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(fetchedVerification.status).toBe(200)

    const completedVerification = await requestJson(
      `http://pirate.test/verification-sessions/${verificationBody.verification_session_id}/complete`,
      {
        proof_hash: "proof-hash-1",
      },
      ctx.env,
      session.accessToken,
    )
    expect(completedVerification.status).toBe(200)
    const completedVerificationBody = await json(completedVerification) as {
      status: string
      attestation_id: string | null
    }
    expect(completedVerificationBody.status).toBe("verified")
    expect(typeof completedVerificationBody.attestation_id).toBe("string")

    const createdNamespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
      family: "hns",
      root_label: "PirateTestRoot",
    }, ctx.env, session.accessToken)
    expect(createdNamespaceSession.status).toBe(201)
    const namespaceSessionBody = await json(createdNamespaceSession) as {
      namespace_verification_session_id: string
      status: string
      challenge_host: string | null
      challenge_txt_value: string | null
    }
    expect(namespaceSessionBody.status).toBe("challenge_required")
    expect(typeof namespaceSessionBody.challenge_host).toBe("string")
    expect(typeof namespaceSessionBody.challenge_txt_value).toBe("string")

    const completedNamespaceSession = await requestJson(
      `http://pirate.test/namespace-verification-sessions/${namespaceSessionBody.namespace_verification_session_id}/complete`,
      {},
      ctx.env,
      session.accessToken,
    )
    expect(completedNamespaceSession.status).toBe(200)
    const completedNamespaceBody = await json(completedNamespaceSession) as {
      status: string
      namespace_verification_id: string | null
    }
    expect(completedNamespaceBody.status).toBe("verified")
    expect(typeof completedNamespaceBody.namespace_verification_id).toBe("string")

    const fetchedNamespaceVerification = await app.request(
      `http://pirate.test/namespace-verifications/${completedNamespaceBody.namespace_verification_id}`,
      {
        headers: {
          authorization: `Bearer ${session.accessToken}`,
        },
      },
      ctx.env,
    )
    expect(fetchedNamespaceVerification.status).toBe(200)
    const fetchedNamespaceBody = await json(fetchedNamespaceVerification) as {
      status: string
      capabilities: { club_attach_allowed: boolean | null }
    }
    expect(fetchedNamespaceBody.status).toBe("verified")
    expect(fetchedNamespaceBody.capabilities.club_attach_allowed).toBe(true)
  })
})
