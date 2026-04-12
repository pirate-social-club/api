import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../src/index"
import { json, mintUpstreamJwt, createRouteTestContext, resetRuntimeCaches } from "./helpers"
import type { Env } from "../src/types"
import {
  buildStubSpacesRootPubkey,
  buildStubSpacesSignature,
} from "../src/lib/verification/spaces-verifier"

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

async function completeVeryVerification(
  env: Env,
  accessToken: string,
  verificationSessionId: string,
  proof: string,
  status: "valid" | "invalid" = "valid",
): Promise<Response> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
    if (url === "https://verify.very.org/api/v1/verify") {
      return new Response(JSON.stringify({ status }), {
        status: status === "valid" ? 200 : 400,
        headers: {
          "content-type": "application/json",
        },
      })
    }
    return originalFetch(input, init)
  }) as typeof globalThis.fetch

  try {
    return await requestJson(
      `http://pirate.test/verification-sessions/${verificationSessionId}/complete`,
      { proof },
      env,
      accessToken,
    )
  } finally {
    globalThis.fetch = originalFetch
  }
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
  test("self sessions expose callback launch metadata and callback rejects malformed payloads without auth", async () => {
    const ctx = await createRouteTestContext({
      PIRATE_API_PUBLIC_ORIGIN: "https://api.pirate.example",
      SELF_VERIFICATION_SCOPE: "pirate-verification-v0",
      SELF_MOCK_PASSPORT: "true",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "self-callback-user")

    const createdVerification = await requestJson("http://pirate.test/verification-sessions", {
      provider: "self",
    }, ctx.env, session.accessToken)
    expect(createdVerification.status).toBe(201)
    const verificationBody = await json(createdVerification) as {
      verification_session_id: string
      callback_path?: string
      launch?: {
        self_app?: {
          endpoint?: string
          endpoint_type?: string
          user_id_type?: string
          dev_mode?: boolean
        }
      } | null
    }

    expect(verificationBody.callback_path).toBe(
      `/verification-sessions/${verificationBody.verification_session_id}/callback`,
    )
    expect(verificationBody.launch?.self_app?.endpoint).toBe(
      `https://api.pirate.example/verification-sessions/${verificationBody.verification_session_id}/callback`,
    )
    expect(verificationBody.launch?.self_app?.endpoint_type).toBe("staging_https")
    expect(verificationBody.launch?.self_app?.user_id_type).toBe("hex")
    expect(verificationBody.launch?.self_app?.dev_mode).toBe(true)

    const malformedCallback = await requestJson(
      `http://pirate.test/verification-sessions/${verificationBody.verification_session_id}/callback`,
      {},
      ctx.env,
    )
    expect(malformedCallback.status).toBe(400)
  })

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

  test("namespace start reuses the same active session for the same user and root", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-reuse-user")

    const createdVerification = await requestJson("http://pirate.test/verification-sessions", {
      provider: "self",
    }, ctx.env, session.accessToken)
    const verificationBody = await json(createdVerification) as {
      verification_session_id: string
    }

    const completedVerification = await requestJson(
      `http://pirate.test/verification-sessions/${verificationBody.verification_session_id}/complete`,
      {
        proof_hash: "proof-hash-reuse",
      },
      ctx.env,
      session.accessToken,
    )
    expect(completedVerification.status).toBe(200)

    const createdNamespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
      family: "hns",
      root_label: "xn--119h",
    }, ctx.env, session.accessToken)
    expect(createdNamespaceSession.status).toBe(201)
    const firstBody = await json(createdNamespaceSession) as {
      namespace_verification_session_id: string
      challenge_txt_value: string | null
      status: string
    }
    expect(firstBody.status).toBe("challenge_required")

    const restartedNamespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
      family: "hns",
      root_label: "xn--119h",
    }, ctx.env, session.accessToken)
    expect(restartedNamespaceSession.status).toBe(201)
    const secondBody = await json(restartedNamespaceSession) as {
      namespace_verification_session_id: string
      challenge_txt_value: string | null
      status: string
    }

    expect(secondBody.namespace_verification_session_id).toBe(firstBody.namespace_verification_session_id)
    expect(secondBody.challenge_txt_value).toBe(firstBody.challenge_txt_value)
    expect(secondBody.status).toBe("challenge_required")
  })

  test("spaces namespace endpoints work through the full route stack", async () => {
    const ctx = await createRouteTestContext({
      ALLOW_STUB_NAMESPACE_VERIFICATION: "true",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-spaces-user")

    const createdVerification = await requestJson("http://pirate.test/verification-sessions", {
      provider: "self",
    }, ctx.env, session.accessToken)
    const verificationBody = await json(createdVerification) as {
      verification_session_id: string
    }

    const completedVerification = await requestJson(
      `http://pirate.test/verification-sessions/${verificationBody.verification_session_id}/complete`,
      {
        proof_hash: "proof-hash-spaces",
      },
      ctx.env,
      session.accessToken,
    )
    expect(completedVerification.status).toBe(200)

    const createdNamespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
      family: "spaces",
      root_label: "@pirate",
    }, ctx.env, session.accessToken)
    expect(createdNamespaceSession.status).toBe(201)
    const namespaceSessionBody = await json(createdNamespaceSession) as {
      namespace_verification_session_id: string
      status: string
      challenge_kind: string | null
      challenge_payload: { digest?: string | null } | null
    }
    expect(namespaceSessionBody.status).toBe("challenge_pending")
    expect(namespaceSessionBody.challenge_kind).toBe("schnorr_sign")
    expect(typeof namespaceSessionBody.challenge_payload?.digest).toBe("string")

    const digest = namespaceSessionBody.challenge_payload?.digest ?? null
    expect(digest).not.toBeNull()

    const rootPubkey = buildStubSpacesRootPubkey("pirate")
    const signature = buildStubSpacesSignature({
      digest: digest as string,
      rootPubkey,
    })

    const completedNamespaceSession = await requestJson(
      `http://pirate.test/namespace-verification-sessions/${namespaceSessionBody.namespace_verification_session_id}/complete`,
      {
        signature_payload: {
          signature,
          algorithm: "bip340_schnorr",
          signer_pubkey: rootPubkey,
          digest,
        },
      },
      ctx.env,
      session.accessToken,
    )
    expect(completedNamespaceSession.status).toBe(200)
    const completedNamespaceBody = await json(completedNamespaceSession) as {
      status: string
      namespace_verification_id: string | null
      family: string
    }
    expect(completedNamespaceBody.status).toBe("verified")
    expect(completedNamespaceBody.family).toBe("spaces")
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
      family: string
      status: string
      capabilities: { club_attach_allowed: boolean | null }
    }
    expect(fetchedNamespaceBody.family).toBe("spaces")
    expect(fetchedNamespaceBody.status).toBe("verified")
    expect(fetchedNamespaceBody.capabilities.club_attach_allowed).toBe(true)
  })

  test("spaces namespace completion fails for a wrong signer", async () => {
    const ctx = await createRouteTestContext({
      ALLOW_STUB_NAMESPACE_VERIFICATION: "true",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-spaces-wrong-signer-user")

    const createdVerification = await requestJson("http://pirate.test/verification-sessions", {
      provider: "self",
    }, ctx.env, session.accessToken)
    const verificationBody = await json(createdVerification) as {
      verification_session_id: string
    }

    const completedVerification = await requestJson(
      `http://pirate.test/verification-sessions/${verificationBody.verification_session_id}/complete`,
      {
        proof_hash: "proof-hash-spaces-wrong-signer",
      },
      ctx.env,
      session.accessToken,
    )
    expect(completedVerification.status).toBe(200)

    const createdNamespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
      family: "spaces",
      root_label: "@pirate",
    }, ctx.env, session.accessToken)
    expect(createdNamespaceSession.status).toBe(201)
    const namespaceSessionBody = await json(createdNamespaceSession) as {
      namespace_verification_session_id: string
      challenge_payload: { digest?: string | null } | null
    }

    const digest = namespaceSessionBody.challenge_payload?.digest ?? null
    expect(typeof digest).toBe("string")

    const rootPubkey = buildStubSpacesRootPubkey("pirate")
    const signature = buildStubSpacesSignature({
      digest: digest as string,
      rootPubkey,
    })

    const completedNamespaceSession = await requestJson(
      `http://pirate.test/namespace-verification-sessions/${namespaceSessionBody.namespace_verification_session_id}/complete`,
      {
        signature_payload: {
          signature,
          algorithm: "bip340_schnorr",
          signer_pubkey: "stub-spaces-pubkey:not-pirate",
          digest,
        },
      },
      ctx.env,
      session.accessToken,
    )
    expect(completedNamespaceSession.status).toBe(200)
    const completedNamespaceBody = await json(completedNamespaceSession) as {
      status: string
      family: string
      failure_reason: string | null
      namespace_verification_id: string | null
    }
    expect(completedNamespaceBody.status).toBe("failed")
    expect(completedNamespaceBody.family).toBe("spaces")
    expect(completedNamespaceBody.failure_reason).toBe("wrong_signer")
    expect(completedNamespaceBody.namespace_verification_id).toBeNull()
  })

  test("spaces stub verification is rejected outside local environments", async () => {
    const ctx = await createRouteTestContext({
      ENVIRONMENT: "production",
      ALLOW_STUB_NAMESPACE_VERIFICATION: "true",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-spaces-prod-stub-user")

    const createdVerification = await requestJson("http://pirate.test/verification-sessions", {
      provider: "self",
    }, ctx.env, session.accessToken)
    const verificationBody = await json(createdVerification) as {
      verification_session_id: string
    }

    const completedVerification = await requestJson(
      `http://pirate.test/verification-sessions/${verificationBody.verification_session_id}/complete`,
      {
        proof_hash: "proof-hash-spaces-prod-stub",
      },
      ctx.env,
      session.accessToken,
    )
    expect(completedVerification.status).toBe(200)

    const createdNamespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
      family: "spaces",
      root_label: "@pirate",
    }, ctx.env, session.accessToken)
    expect(createdNamespaceSession.status).toBe(500)
    const body = await json(createdNamespaceSession) as {
      code: string
      message: string
    }
    expect(body.code).toBe("internal_error")
    expect(body.message).toContain("ALLOW_STUB_NAMESPACE_VERIFICATION")
  })

  test("very verification completion requires a valid proof", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-very-user")

    const createdVerification = await requestJson("http://pirate.test/verification-sessions", {
      provider: "very",
    }, ctx.env, session.accessToken)
    expect(createdVerification.status).toBe(201)
    const verificationBody = await json(createdVerification) as {
      verification_session_id: string
    }

    const missingProof = await requestJson(
      `http://pirate.test/verification-sessions/${verificationBody.verification_session_id}/complete`,
      {},
      ctx.env,
      session.accessToken,
    )
    expect(missingProof.status).toBe(400)

    const invalidProof = await completeVeryVerification(
      ctx.env,
      session.accessToken,
      verificationBody.verification_session_id,
      "invalid-very-proof",
      "invalid",
    )
    expect(invalidProof.status).toBe(403)

    const validProof = await completeVeryVerification(
      ctx.env,
      session.accessToken,
      verificationBody.verification_session_id,
      "valid-very-proof",
      "valid",
    )
    expect(validProof.status).toBe(200)
    const validBody = await json(validProof) as { status: string; attestation_id: string | null }
    expect(validBody.status).toBe("verified")
    expect(typeof validBody.attestation_id).toBe("string")
  })
})
