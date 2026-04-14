import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../src/index"
import { json, mintUpstreamJwt, createRouteTestContext, resetRuntimeCaches } from "./helpers"
import type { Env } from "../src/types"

let cleanup: (() => Promise<void>) | null = null

async function withFetchMock(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  run: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = handler as typeof globalThis.fetch
  try {
    await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

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
      attestation_ids: string[]
    }
    expect(completedVerificationBody.status).toBe("verified")
    expect(Array.isArray(completedVerificationBody.attestation_ids)).toBe(true)
    expect(completedVerificationBody.attestation_ids.length).toBeGreaterThan(0)
    expect(typeof completedVerificationBody.attestation_ids[0]).toBe("string")

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

    const createdVerification = await requestJson("http://pirate.test/verification-sessions", {
      provider: "very",
      verification_intent: "community_creation",
    }, ctx.env, session.accessToken)
    expect(createdVerification.status).toBe(201)
    const createdBody = await json(createdVerification) as {
      verification_session_id: string
      status: string
      provider_mode: string | null
      launch?: { very_widget?: { verify_url: string } }
    }
    expect(createdBody.status).toBe("pending")
    expect(createdBody.provider_mode).toBe("widget")
    expect(createdBody.launch?.very_widget?.verify_url).toBe("https://very.test/api/v1/verify")

    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
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
        attestation_ids: string[]
      }
      expect(completedBody.status).toBe("verified")
      expect(typeof completedBody.proof_hash).toBe("string")
      expect(completedBody.attestation_ids.length).toBe(1)
    })
  })

  test("spaces namespace verification starts and completes with a signed challenge payload", async () => {
    const ctx = await createRouteTestContext({
      SPACES_VERIFIER_BASE_URL: "http://spaces-verifier.test",
      SPACES_VERIFIER_CHALLENGE_DOMAIN: "pirate.sc",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-spaces-user")

    const verificationSession = await requestJson("http://pirate.test/verification-sessions", {
      provider: "self",
    }, ctx.env, session.accessToken)
    const verificationBody = await json(verificationSession) as { verification_session_id: string }
    await requestJson(
      `http://pirate.test/verification-sessions/${verificationBody.verification_session_id}/complete`,
      {},
      ctx.env,
      session.accessToken,
    )

    const originalFetch = globalThis.fetch
    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("http://spaces-verifier.test/inspect?")) {
        return new Response(JSON.stringify({
          root_exists: true,
          root_key_proof_verified: true,
          root_pubkey: "spaces-root-pubkey",
          control_class: "single_holder_root",
          operation_class: "owner_managed_namespace",
          observation_provider: "spaces_verifier",
          anchor_height: 42,
          anchor_block_hash: "block-hash",
          anchor_root_hash: "anchor-root",
          proof_root_hash: "proof-root",
          anchor_fresh_enough: true,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url === "http://spaces-verifier.test/verify-signature") {
        const body = JSON.parse(String(init?.body))
        expect(body.digest).toBe("spaces-digest")
        expect(body.signature).toBe("spaces-signature")
        expect(body.root_pubkey).toBe("spaces-root-pubkey")
        return new Response(JSON.stringify({
          valid_signature: true,
          observation_provider: "spaces_verifier",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return originalFetch(input, init)
    }, async () => {
      const createdNamespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
        family: "spaces",
        root_label: "@pirate-space-root",
      }, ctx.env, session.accessToken)
      expect(createdNamespaceSession.status).toBe(201)
      const createdBody = await json(createdNamespaceSession) as {
        namespace_verification_session_id: string
        family: string
        challenge_kind: string | null
        challenge_payload: { root_pubkey?: string } | null
      }
      expect(createdBody.family).toBe("spaces")
      expect(createdBody.challenge_kind).toBe("schnorr_sign")
      expect(createdBody.challenge_payload?.root_pubkey).toBe("spaces-root-pubkey")

      const completedNamespaceSession = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${createdBody.namespace_verification_session_id}/complete`,
        {
          signature_payload: {
            digest: "spaces-digest",
            signature: "spaces-signature",
            root_pubkey: "spaces-root-pubkey",
          },
        },
        ctx.env,
        session.accessToken,
      )
      expect(completedNamespaceSession.status).toBe(200)
      const completedBody = await json(completedNamespaceSession) as {
        status: string
        family: string
        namespace_verification_id: string | null
      }
      expect(completedBody.status).toBe("verified")
      expect(completedBody.family).toBe("spaces")
      expect(typeof completedBody.namespace_verification_id).toBe("string")
    })
  })

  test("namespace verification publishes and verifies through the configured HNS verifier", async () => {
    const ctx = await createRouteTestContext({
      HNS_VERIFIER_BASE_URL: "http://hns-verifier.test",
      HNS_VERIFIER_AUTH_TOKEN: "test-hns-token",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-hns-user")

    const verificationSession = await requestJson("http://pirate.test/verification-sessions", {
      provider: "self",
    }, ctx.env, session.accessToken)
    const verificationBody = await json(verificationSession) as { verification_session_id: string }
    await requestJson(
      `http://pirate.test/verification-sessions/${verificationBody.verification_session_id}/complete`,
      {},
      ctx.env,
      session.accessToken,
    )

    const calls: Array<{ url: string; body: unknown }> = []
    const originalFetch = globalThis.fetch

    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("http://hns-verifier.test")) {
        const body = init?.body ? JSON.parse(String(init.body)) : null
        calls.push({ url, body })

        if (url.endsWith("/publish-txt")) {
          return new Response(JSON.stringify({
            observation_provider: "powerdns_api",
            zone_created: true,
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }

        if (url.includes("/inspect?")) {
          return new Response(JSON.stringify({
            zone_exists: false,
            challenge_present: false,
            observation_provider: "powerdns_api",
            failure_reason: "zone_not_provisioned",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }

        if (url.endsWith("/verify-txt")) {
          return new Response(JSON.stringify({
            verified: true,
            observation_provider: "powerdns_api",
            failure_reason: null,
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
      }

      return originalFetch(input, init)
    }, async () => {
      const createdNamespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
        family: "hns",
        root_label: "PirateVerifierRoot",
      }, ctx.env, session.accessToken)
      expect(createdNamespaceSession.status).toBe(201)
      const namespaceSessionBody = await json(createdNamespaceSession) as {
        namespace_verification_session_id: string
        status: string
        challenge_txt_value: string
        observation_provider: string | null
      }
      expect(namespaceSessionBody.status).toBe("challenge_required")
      expect(namespaceSessionBody.observation_provider).toBe("powerdns_api")

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
        observation_provider: string | null
      }
      expect(completedNamespaceBody.status).toBe("verified")
      expect(typeof completedNamespaceBody.namespace_verification_id).toBe("string")
      expect(completedNamespaceBody.observation_provider).toBe("powerdns_api")

      expect(calls.length).toBe(3)
      expect(calls[0]?.url.includes("/inspect?")).toBe(true)
      expect(calls[1]?.url.endsWith("/publish-txt")).toBe(true)
      expect(calls[2]?.url.endsWith("/verify-txt")).toBe(true)
      expect((calls[1]?.body as { challenge_txt_value?: string })?.challenge_txt_value).toBe(namespaceSessionBody.challenge_txt_value)
    })
  })

  test("namespace verification fails cleanly when the HNS verifier rejects the TXT proof", async () => {
    const ctx = await createRouteTestContext({
      HNS_VERIFIER_BASE_URL: "http://hns-verifier.test",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-hns-failure-user")

    const verificationSession = await requestJson("http://pirate.test/verification-sessions", {
      provider: "self",
    }, ctx.env, session.accessToken)
    const verificationBody = await json(verificationSession) as { verification_session_id: string }
    await requestJson(
      `http://pirate.test/verification-sessions/${verificationBody.verification_session_id}/complete`,
      {},
      ctx.env,
      session.accessToken,
    )

    const originalFetch = globalThis.fetch
    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("http://hns-verifier.test")) {
        if (url.includes("/inspect?")) {
          return new Response(JSON.stringify({
            zone_exists: false,
            challenge_present: false,
            observation_provider: "powerdns_api",
            failure_reason: "zone_not_provisioned",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }

        if (url.endsWith("/publish-txt")) {
          return new Response(JSON.stringify({
            observation_provider: "powerdns_api",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }

        if (url.endsWith("/verify-txt")) {
          return new Response(JSON.stringify({
            verified: false,
            observation_provider: "powerdns_api",
            failure_reason: "challenge_mismatch",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
      }

      return originalFetch(input, init)
    }, async () => {
      const createdNamespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
        family: "hns",
        root_label: "PirateVerifierFailRoot",
      }, ctx.env, session.accessToken)
      const namespaceSessionBody = await json(createdNamespaceSession) as {
        namespace_verification_session_id: string
      }

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
        failure_reason: string | null
        observation_provider: string | null
      }
      expect(completedNamespaceBody.status).toBe("failed")
      expect(completedNamespaceBody.namespace_verification_id).toBeNull()
      expect(completedNamespaceBody.failure_reason).toBe("challenge_mismatch")
      expect(completedNamespaceBody.observation_provider).toBe("powerdns_api")
    })
  })

  test("namespace verification restart clears accepted metadata and renews session expiry", async () => {
    const ctx = await createRouteTestContext({
      HNS_VERIFIER_BASE_URL: "http://hns-verifier.test",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-hns-restart-user")

    const verificationSession = await requestJson("http://pirate.test/verification-sessions", {
      provider: "self",
    }, ctx.env, session.accessToken)
    const verificationBody = await json(verificationSession) as { verification_session_id: string }
    await requestJson(
      `http://pirate.test/verification-sessions/${verificationBody.verification_session_id}/complete`,
      {},
      ctx.env,
      session.accessToken,
    )

    const originalFetch = globalThis.fetch
    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("http://hns-verifier.test")) {
        if (url.includes("/inspect?")) {
          return new Response(JSON.stringify({
            root_exists: true,
            expiry_horizon_sufficient: true,
            routing_enabled: true,
            pirate_dns_authority_verified: false,
            control_class: "single_holder_root",
            operation_class: "owner_managed_namespace",
            observation_provider: "powerdns_api",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }

        if (url.endsWith("/publish-txt")) {
          return new Response(JSON.stringify({
            observation_provider: "powerdns_api",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }

        if (url.endsWith("/verify-txt")) {
          return new Response(JSON.stringify({
            verified: true,
            observation_provider: "powerdns_api",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
      }

      return originalFetch(input, init)
    }, async () => {
      const createdNamespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
        family: "hns",
        root_label: "PirateRestartRoot",
      }, ctx.env, session.accessToken)
      const createdBody = await json(createdNamespaceSession) as {
        namespace_verification_session_id: string
        challenge_txt_value: string | null
        expires_at: string
      }

      const completedNamespaceSession = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${createdBody.namespace_verification_session_id}/complete`,
        {},
        ctx.env,
        session.accessToken,
      )
      const completedBody = await json(completedNamespaceSession) as {
        status: string
        namespace_verification_id: string | null
        evidence_bundle_ref: string | null
        accepted_at: string | null
      }
      expect(completedBody.status).toBe("verified")
      expect(typeof completedBody.namespace_verification_id).toBe("string")
      expect(typeof completedBody.evidence_bundle_ref).toBe("string")
      expect(typeof completedBody.accepted_at).toBe("string")

      const restartedNamespaceSession = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${createdBody.namespace_verification_session_id}/complete`,
        { restart_challenge: true },
        ctx.env,
        session.accessToken,
      )
      expect(restartedNamespaceSession.status).toBe(200)
      const restartedBody = await json(restartedNamespaceSession) as {
        status: string
        namespace_verification_id: string | null
        evidence_bundle_ref: string | null
        accepted_at: string | null
        failure_reason: string | null
        challenge_txt_value: string | null
        expires_at: string
      }
      expect(restartedBody.status).toBe("challenge_required")
      expect(restartedBody.namespace_verification_id).toBeNull()
      expect(restartedBody.evidence_bundle_ref).toBeNull()
      expect(restartedBody.accepted_at).toBeNull()
      expect(restartedBody.failure_reason).toBeNull()
      expect(restartedBody.challenge_txt_value).not.toBe(createdBody.challenge_txt_value)
      expect(new Date(restartedBody.expires_at).getTime()).toBeGreaterThan(new Date(createdBody.expires_at).getTime())
    })
  })

  test("namespace verification expires stale sessions before verifier completion", async () => {
    const ctx = await createRouteTestContext({
      HNS_VERIFIER_BASE_URL: "http://hns-verifier.test",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-hns-expiry-user")

    const verificationSession = await requestJson("http://pirate.test/verification-sessions", {
      provider: "self",
    }, ctx.env, session.accessToken)
    const verificationBody = await json(verificationSession) as { verification_session_id: string }
    await requestJson(
      `http://pirate.test/verification-sessions/${verificationBody.verification_session_id}/complete`,
      {},
      ctx.env,
      session.accessToken,
    )

    const originalFetch = globalThis.fetch
    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("http://hns-verifier.test")) {
        if (url.includes("/inspect?")) {
          return new Response(JSON.stringify({
            root_exists: true,
            expiry_horizon_sufficient: true,
            observation_provider: "powerdns_api",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }

        if (url.endsWith("/publish-txt")) {
          return new Response(JSON.stringify({
            observation_provider: "powerdns_api",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
      }

      return originalFetch(input, init)
    }, async () => {
      const createdNamespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
        family: "hns",
        root_label: "PirateExpiryRoot",
      }, ctx.env, session.accessToken)
      const createdBody = await json(createdNamespaceSession) as {
        namespace_verification_session_id: string
      }

      await ctx.client.execute({
        sql: `
          UPDATE namespace_verification_sessions
          SET expires_at = ?2
          WHERE namespace_verification_session_id = ?1
        `,
        args: [createdBody.namespace_verification_session_id, new Date(Date.now() - 60_000).toISOString()],
      })

      const completedNamespaceSession = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${createdBody.namespace_verification_session_id}/complete`,
        {},
        ctx.env,
        session.accessToken,
      )
      expect(completedNamespaceSession.status).toBe(200)
      const completedBody = await json(completedNamespaceSession) as {
        status: string
        failure_reason: string | null
      }
      expect(completedBody.status).toBe("expired")
      expect(completedBody.failure_reason).toBe("session_expired")
    })
  })

  test("namespace verification preserves inspection-derived assertions on acceptance", async () => {
    const ctx = await createRouteTestContext({
      HNS_VERIFIER_BASE_URL: "http://hns-verifier.test",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-hns-assertions-user")

    const verificationSession = await requestJson("http://pirate.test/verification-sessions", {
      provider: "self",
    }, ctx.env, session.accessToken)
    const verificationBody = await json(verificationSession) as { verification_session_id: string }
    await requestJson(
      `http://pirate.test/verification-sessions/${verificationBody.verification_session_id}/complete`,
      {},
      ctx.env,
      session.accessToken,
    )

    const originalFetch = globalThis.fetch
    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("http://hns-verifier.test")) {
        if (url.includes("/inspect?")) {
          return new Response(JSON.stringify({
            root_exists: true,
            expiry_horizon_sufficient: false,
            routing_enabled: true,
            pirate_dns_authority_verified: true,
            control_class: "dao_controlled_root",
            operation_class: "routing_only_namespace",
            observation_provider: "powerdns_api",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }

        if (url.endsWith("/publish-txt")) {
          return new Response(JSON.stringify({
            observation_provider: "powerdns_api",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }

        if (url.endsWith("/verify-txt")) {
          return new Response(JSON.stringify({
            verified: true,
            observation_provider: "powerdns_api",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
      }

      return originalFetch(input, init)
    }, async () => {
      const createdNamespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
        family: "hns",
        root_label: "PirateAssertionsRoot",
      }, ctx.env, session.accessToken)
      const createdBody = await json(createdNamespaceSession) as {
        namespace_verification_session_id: string
      }

      const completedNamespaceSession = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${createdBody.namespace_verification_session_id}/complete`,
        {},
        ctx.env,
        session.accessToken,
      )
      const completedBody = await json(completedNamespaceSession) as {
        namespace_verification_id: string | null
      }
      expect(typeof completedBody.namespace_verification_id).toBe("string")

      const fetchedNamespaceVerification = await app.request(
        `http://pirate.test/namespace-verifications/${completedBody.namespace_verification_id}`,
        {
          headers: {
            authorization: `Bearer ${session.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(fetchedNamespaceVerification.status).toBe(200)
      const fetchedBody = await json(fetchedNamespaceVerification) as {
        assertions: {
          root_exists: boolean | null
          root_control_verified: boolean | null
          expiry_horizon_sufficient: boolean | null
          routing_enabled: boolean | null
          pirate_dns_authority_verified: boolean | null
        }
        capabilities: {
          club_attach_allowed: boolean | null
          pirate_web_routing_allowed: boolean | null
          pirate_subdomain_issuance_allowed: boolean | null
        }
        control_class: string | null
        operation_class: string | null
      }
      expect(fetchedBody.assertions.root_exists).toBe(true)
      expect(fetchedBody.assertions.root_control_verified).toBe(true)
      expect(fetchedBody.assertions.expiry_horizon_sufficient).toBe(false)
      expect(fetchedBody.assertions.routing_enabled).toBe(true)
      expect(fetchedBody.assertions.pirate_dns_authority_verified).toBe(true)
      expect(fetchedBody.capabilities.club_attach_allowed).toBe(false)
      expect(fetchedBody.capabilities.pirate_web_routing_allowed).toBe(true)
      expect(fetchedBody.capabilities.pirate_subdomain_issuance_allowed).toBe(false)
      expect(fetchedBody.control_class).toBe("dao_controlled_root")
      expect(fetchedBody.operation_class).toBe("routing_only_namespace")
    })
  })
})
