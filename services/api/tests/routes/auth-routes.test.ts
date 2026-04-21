import { beforeEach, describe, expect, test } from "bun:test"
import app from "../../src/index"
import { setPrivyAccessProofVerifierForTests } from "../../src/lib/auth/privy-auth"
import type { Env } from "../../src/types"
import { buildTestEnv, json, mintUpstreamJwt, resetMemoryStore } from "../helpers"

function makeJsonRequest(url: string, body: unknown, env: Env): Promise<Response> {
  return Promise.resolve(app.request(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    },
    env,
  ))
}

async function expectAuthError(response: Response): Promise<void> {
  expect(response.status).toBe(401)
  const body = await json(response) as { code?: unknown; message?: unknown; retryable?: unknown }
  expect(body.code).toBe("auth_error")
  expect(body.retryable).toBe(false)
  expect(typeof body.message).toBe("string")
}

beforeEach(() => {
  resetMemoryStore()
  setPrivyAccessProofVerifierForTests(null)
})

describe("auth routes", () => {
  test("session exchange creates a JWT-path user and returns the expected contract shape", async () => {
    const env = buildTestEnv()
    const jwt = await mintUpstreamJwt(env, { sub: "alice" })

    const response = await makeJsonRequest("http://pirate.test/auth/session/exchange", {
      proof: {
        type: "jwt_based_auth",
        jwt,
      },
    }, env)

    expect(response.status).toBe(200)
    const body = await json(response) as {
      access_token: string
      user: { user_id: string; primary_wallet_attachment_id: string | null; verification_state: string }
      profile: { global_handle: { label: string; issuance_source: string; free_rename_consumed: boolean } }
      onboarding: { generated_handle_assigned: boolean; cleanup_rename_available: boolean }
      wallet_attachments: unknown[]
    }

    expect(typeof body.access_token).toBe("string")
    expect(body.user.verification_state).toBe("unverified")
    expect(body.user.primary_wallet_attachment_id).toBeNull()
    expect(body.wallet_attachments).toEqual([])
    expect(body.profile.global_handle.label).toMatch(/^[a-z]+-[a-z]+-\d{4}\.pirate$/)
    expect(body.profile.global_handle.issuance_source).toBe("generated_signup")
    expect(body.profile.global_handle.free_rename_consumed).toBe(false)
    expect(body.onboarding.generated_handle_assigned).toBe(true)
    expect(body.onboarding.cleanup_rename_available).toBe(true)
  })

  test("re-exchanging the same upstream JWT resolves the same user", async () => {
    const env = buildTestEnv()
    const jwt = await mintUpstreamJwt(env, { sub: "repeat-user" })

    const first = await makeJsonRequest("http://pirate.test/auth/session/exchange", {
      proof: {
        type: "jwt_based_auth",
        jwt,
      },
    }, env)
    const second = await makeJsonRequest("http://pirate.test/auth/session/exchange", {
      proof: {
        type: "jwt_based_auth",
        jwt,
      },
    }, env)

    const firstBody = await json(first) as { user: { user_id: string } }
    const secondBody = await json(second) as { user: { user_id: string } }
    expect(firstBody.user.user_id).toBe(secondBody.user.user_id)
  })

  test("users/me and onboarding/status accept the returned Pirate access token", async () => {
    const env = buildTestEnv()
    const jwt = await mintUpstreamJwt(env, { sub: "session-user" })

    const exchange = await makeJsonRequest("http://pirate.test/auth/session/exchange", {
      proof: {
        type: "jwt_based_auth",
        jwt,
      },
    }, env)
    const exchangeBody = await json(exchange) as { access_token: string; user: { user_id: string } }

    const me = await app.request("http://pirate.test/users/me", {
      headers: {
        authorization: `Bearer ${exchangeBody.access_token}`,
      },
    }, env)
    expect(me.status).toBe(200)
    const meBody = await json(me) as { user_id: string }
    expect(meBody.user_id).toBe(exchangeBody.user.user_id)

    const onboarding = await app.request("http://pirate.test/onboarding/status", {
      headers: {
        authorization: `Bearer ${exchangeBody.access_token}`,
      },
    }, env)
    expect(onboarding.status).toBe(200)
    const onboardingBody = await json(onboarding) as {
      generated_handle_assigned: boolean
      cleanup_rename_available: boolean
      missing_requirements: string[]
    }
    expect(onboardingBody.generated_handle_assigned).toBe(true)
    expect(onboardingBody.cleanup_rename_available).toBe(true)
    expect(onboardingBody.missing_requirements).toEqual(["unique_human_verification", "namespace_verification"])
  })

  test("malformed JWT returns auth_error", async () => {
    const env = buildTestEnv()
    const response = await makeJsonRequest("http://pirate.test/auth/session/exchange", {
      proof: {
        type: "jwt_based_auth",
        jwt: "not-a-jwt",
      },
    }, env)
    await expectAuthError(response)
  })

  test("wrong issuer returns auth_error", async () => {
    const env = buildTestEnv()
    const jwt = await mintUpstreamJwt(env, { sub: "issuer-user", iss: "unexpected-issuer" })
    const response = await makeJsonRequest("http://pirate.test/auth/session/exchange", {
      proof: {
        type: "jwt_based_auth",
        jwt,
      },
    }, env)
    await expectAuthError(response)
  })

  test("wrong audience returns auth_error", async () => {
    const env = buildTestEnv()
    const jwt = await mintUpstreamJwt(env, { sub: "aud-user", aud: "not-pirate-api" })
    const response = await makeJsonRequest("http://pirate.test/auth/session/exchange", {
      proof: {
        type: "jwt_based_auth",
        jwt,
      },
    }, env)
    await expectAuthError(response)
  })

  test("expired JWT returns auth_error", async () => {
    const env = buildTestEnv()
    const jwt = await mintUpstreamJwt(env, {
      sub: "expired-user",
      exp: Math.floor(Date.now() / 1000) - 60,
    })
    const response = await makeJsonRequest("http://pirate.test/auth/session/exchange", {
      proof: {
        type: "jwt_based_auth",
        jwt,
      },
    }, env)
    await expectAuthError(response)
  })

  test("missing bearer token returns auth_error", async () => {
    const env = buildTestEnv()
    const response = await app.request("http://pirate.test/users/me", {}, env)
    await expectAuthError(response)
  })

  test("privy route exchanges into the same response contract and persists wallet selections in memory mode", async () => {
    const env = buildTestEnv()
    setPrivyAccessProofVerifierForTests(async ({ walletAddress }) => ({
      provider: "privy",
      providerSubject: "did:privy:test-user",
      providerUserRef: "did:privy:test-user",
      walletAddresses: [
        "0x1111111111111111111111111111111111111111",
        "0x2222222222222222222222222222222222222222",
      ],
      selectedWalletAddress: walletAddress ?? "0x1111111111111111111111111111111111111111",
    }))

    const response = await makeJsonRequest("http://pirate.test/auth/session/exchange", {
      proof: {
        type: "privy_access_token",
        privy_access_token: "test-privy-token",
        wallet_address: "0x2222222222222222222222222222222222222222",
      },
    }, env)

    expect(response.status).toBe(200)
    const body = await json(response) as {
      wallet_attachments: Array<{ wallet_address: string; is_primary: boolean }>
      user: { primary_wallet_attachment_id: string | null }
    }

    expect(body.wallet_attachments).toHaveLength(2)
    expect(body.wallet_attachments.find((attachment) => attachment.is_primary)?.wallet_address).toBe(
      "0x2222222222222222222222222222222222222222",
    )
    expect(typeof body.user.primary_wallet_attachment_id).toBe("string")
  })
})
