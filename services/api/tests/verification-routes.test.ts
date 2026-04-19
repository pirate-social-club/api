import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../src/index"
import { json, createRouteTestContext, resetRuntimeCaches } from "./helpers"
import { setSelfProviderForTests } from "../src/lib/verification/self-provider"
import {
  exchangeJwt,
  requestJson,
  withFetchMock,
} from "./verification-test-helpers"

let cleanup: (() => Promise<void>) | null = null

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
  test("verification session start accepts self gender capability requests", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-gender-user")

    const createdVerification = await requestJson("http://pirate.test/verification-sessions", {
      provider: "self",
      requested_capabilities: ["gender"],
    }, ctx.env, session.accessToken)
    expect(createdVerification.status).toBe(201)
    const body = await json(createdVerification) as {
      status: string
      requested_capabilities: string[]
      launch?: { self_app?: { disclosures?: { gender?: boolean } } }
    }
    expect(body.status).toBe("pending")
    expect(body.requested_capabilities).toEqual(["unique_human", "gender"])
    expect(body.launch?.self_app?.disclosures?.gender).toBe(true)
  })

  test("verification completion fails when self does not return the requested gender claim", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-gender-missing-claim-user")
    setSelfProviderForTests({
      startSession: async () => ({
        upstreamSessionRef: "self-test-ref",
        launch: {
          app_name: "Pirate",
          endpoint: "https://self.xyz",
          endpoint_type: "https",
          scope: "community_join",
          session_id: "self-test-ref",
          user_id: "test",
          user_id_type: "uuid",
          disclosures: { gender: true },
        },
      }),
      getSessionOutcome: async () => ({
        status: "verified",
        claims: { age_over_18: true, nationality: null, gender: null },
      }),
    } satisfies import("../src/lib/verification/self-provider").SelfProvider)

    const createdVerification = await requestJson("http://pirate.test/verification-sessions", {
      provider: "self",
      requested_capabilities: ["gender"],
      verification_intent: "community_join",
    }, ctx.env, session.accessToken)
    expect(createdVerification.status).toBe(201)
    const createdBody = await json(createdVerification) as { verification_session_id: string }

    const completedVerification = await requestJson(
      `http://pirate.test/verification-sessions/${createdBody.verification_session_id}/complete`,
      {},
      ctx.env,
      session.accessToken,
    )
    setSelfProviderForTests(null)

    expect(completedVerification.status).toBe(200)
    const completedBody = await json(completedVerification) as {
      status: string
      failure_reason: string | null
    }
    expect(completedBody.status).toBe("failed")
    expect(completedBody.failure_reason).toBe("missing_required_claims:gender")
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

  test("very verification completes only after the provider confirms the submitted proof", async () => {
    const ctx = await createRouteTestContext({
      VERY_API_URL: "https://very.test",
      VERY_API_KEY: "very-key",
      VERY_APP_ID: "very-app",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-very-user")

    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url === "https://very.test/api/v1/sessions") {
        expect(init?.method).toBe("POST")
        const body = JSON.parse(String(init?.body))
        expect(body.app_id).toBe("very-app")
        expect(body.verify_url).toBe("https://very.test/api/v1/verify")
        return new Response(JSON.stringify({
          session_id: "vs_test_upstream_123",
          app_id: "very-app",
          context: "Veros - Palm Verification Timestamp",
          type_id: "3",
          verify_url: "https://very.test/api/v1/verify",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      expect(url).toBe("https://very.test/api/v1/verify")
      const body = JSON.parse(String(init?.body))
      expect(body.proof).toBe("very-zk-proof-123")
      expect(typeof body.session_id).toBe("string")
      return new Response(JSON.stringify({
        status: "valid",
        data: {
          palm_scan: true,
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    }, async () => {
      const createdVerification = await requestJson("http://pirate.test/verification-sessions", {
        provider: "very",
        verification_intent: "community_creation",
      }, ctx.env, session.accessToken)
      expect(createdVerification.status).toBe(201)
      const createdBody = await json(createdVerification) as {
        verification_session_id: string
        status: string
        provider_mode: string | null
        launch?: { very_widget?: { verify_url?: string } }
      }
      expect(createdBody.status).toBe("pending")
      expect(createdBody.provider_mode).toBe("widget")
      expect(createdBody.launch?.very_widget?.verify_url).toBe("https://very.test/api/v1/verify")

      const completedVerification = await requestJson(
        `http://pirate.test/verification-sessions/${createdBody.verification_session_id}/complete`,
        {
          proof: "very-zk-proof-123",
        },
        ctx.env,
        session.accessToken,
      )
      expect(completedVerification.status).toBe(200)
      const completedBody = await json(completedVerification) as {
        status: string
        proof_hash: string | null
        attestation_id: string | null
      }
      expect(completedBody.status).toBe("verified")
      expect(typeof completedBody.proof_hash).toBe("string")
      expect(typeof completedBody.attestation_id).toBe("string")
    })
  })
  describe("POST /very/verify", () => {
    test("returns valid in development without API key", async () => {
      const ctx = await createRouteTestContext({
        VERY_APP_ID: "test-app",
        ENVIRONMENT: "development",
      })
      cleanup = ctx.cleanup
      const response = await requestJson("http://pirate.test/very/verify", {
        proof: "some-proof-payload",
      }, ctx.env)
      expect(response.status).toBe(200)
      const body = await json(response) as { status: string }
      expect(body.status).toBe("valid")
    })

    test("returns 400 error when proof is missing", async () => {
      const ctx = await createRouteTestContext({
        VERY_APP_ID: "test-app",
        ENVIRONMENT: "development",
      })
      cleanup = ctx.cleanup
      const response = await requestJson("http://pirate.test/very/verify", {}, ctx.env)
      expect(response.status).toBe(400)
    })

    test("returns use_upstream_verifier in production with API key", async () => {
      const ctx = await createRouteTestContext({
        VERY_APP_ID: "test-app",
        VERY_API_KEY: "real-key",
        ENVIRONMENT: "production",
      })
      cleanup = ctx.cleanup
      const response = await requestJson("http://pirate.test/very/verify", {
        proof: "some-proof-payload",
      }, ctx.env)
      expect(response.status).toBe(400)
      const body = await json(response) as { status: string; error: string }
      expect(body.error).toBe("use_upstream_verifier")
    })

    test("returns local_proxy_unavailable without API key in non-development", async () => {
      const ctx = await createRouteTestContext({
        VERY_APP_ID: "test-app",
        ENVIRONMENT: "staging",
      })
      cleanup = ctx.cleanup
      const response = await requestJson("http://pirate.test/very/verify", {
        proof: "some-proof-payload",
      }, ctx.env)
      expect(response.status).toBe(502)
      const body = await json(response) as { status: string; error: string }
      expect(body.error).toBe("local_proxy_unavailable")
    })
  })
})
