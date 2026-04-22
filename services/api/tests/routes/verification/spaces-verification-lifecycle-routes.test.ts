import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import {
  createSelfVerifiedSession,
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

describe("spaces verification lifecycle routes", () => {
  test("spaces session start stores canonical IDNA labels", async () => {
    const ctx = await createRouteTestContext({
      SPACES_VERIFIER_BASE_URL: "http://spaces-verifier.test",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-spaces-idna-user")
    await createSelfVerifiedSession(ctx.env, session.accessToken)

    const originalFetch = globalThis.fetch
    let capturedInspectUrl: string | null = null
    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("http://spaces-verifier.test/inspect?")) {
        capturedInspectUrl = url
        return new Response(JSON.stringify({
          root_exists: true,
          root_key_proof_verified: true,
          root_pubkey: "spaces-root-pubkey",
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
        root_label: "\u{1F1F5}\u{1F1F8}",
      }, ctx.env, session.accessToken)

      expect(createdNamespaceSession.status).toBe(201)
      const createdBody = await json(createdNamespaceSession) as {
        normalized_root_label: string | null
        challenge_payload?: { root_label?: string; message?: string } | null
      }

      expect(capturedInspectUrl).toBe("http://spaces-verifier.test/inspect?root_label=xn--t77hga")
      expect(createdBody.normalized_root_label).toBe("xn--t77hga")
      expect(createdBody.challenge_payload?.root_label).toBe("xn--t77hga")
      expect(createdBody.challenge_payload?.message).toContain("root=@xn--t77hga")
    })
  })

  test("spaces sessions respect challenge and session expiry", async () => {
    const ctx = await createRouteTestContext({
      SPACES_VERIFIER_BASE_URL: "http://spaces-verifier.test",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-spaces-expiry-user")
    await createSelfVerifiedSession(ctx.env, session.accessToken)

    const originalFetch = globalThis.fetch
    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("http://spaces-verifier.test/inspect?")) {
        return new Response(JSON.stringify({
          root_exists: true,
          root_key_proof_verified: true,
          root_pubkey: "spaces-root-pubkey",
          observation_provider: "spaces_verifier",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return originalFetch(input, init)
    }, async () => {
      const challengeExpirySession = await requestJson("http://pirate.test/namespace-verification-sessions", {
        family: "spaces",
        root_label: "@pirate-challenge-expiry-root",
      }, ctx.env, session.accessToken)
      const challengeExpiryBody = await json(challengeExpirySession) as {
        namespace_verification_session_id: string
      }
      await ctx.client.execute({
        sql: `
          UPDATE namespace_verification_sessions
          SET challenge_expires_at = ?2
          WHERE namespace_verification_session_id = ?1
        `,
        args: [challengeExpiryBody.namespace_verification_session_id, new Date(Date.now() - 60_000).toISOString()],
      })

      const expiredChallengeResponse = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${challengeExpiryBody.namespace_verification_session_id}/complete`,
        { signature_payload: { signature: "spaces-signature" } },
        ctx.env,
        session.accessToken,
      )
      expect(expiredChallengeResponse.status).toBe(200)
      const expiredChallengeBody = await json(expiredChallengeResponse) as {
        status: string
        failure_reason: string | null
      }
      expect(expiredChallengeBody.status).toBe("expired")
      expect(expiredChallengeBody.failure_reason).toBe("challenge_expired")

      const sessionExpirySession = await requestJson("http://pirate.test/namespace-verification-sessions", {
        family: "spaces",
        root_label: "@pirate-session-expiry-root",
      }, ctx.env, session.accessToken)
      const sessionExpiryBody = await json(sessionExpirySession) as {
        namespace_verification_session_id: string
      }
      await ctx.client.execute({
        sql: `
          UPDATE namespace_verification_sessions
          SET expires_at = ?2
          WHERE namespace_verification_session_id = ?1
        `,
        args: [sessionExpiryBody.namespace_verification_session_id, new Date(Date.now() - 60_000).toISOString()],
      })

      const expiredSessionResponse = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${sessionExpiryBody.namespace_verification_session_id}/complete`,
        { signature_payload: { signature: "spaces-signature" } },
        ctx.env,
        session.accessToken,
      )
      expect(expiredSessionResponse.status).toBe(200)
      const expiredSessionBody = await json(expiredSessionResponse) as {
        status: string
        failure_reason: string | null
      }
      expect(expiredSessionBody.status).toBe("expired")
      expect(expiredSessionBody.failure_reason).toBe("session_expired")
    })
  })

  test("spaces restart reissues the challenge and clears accepted metadata", async () => {
    const ctx = await createRouteTestContext({
      SPACES_VERIFIER_BASE_URL: "http://spaces-verifier.test",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-spaces-restart-user")
    await createSelfVerifiedSession(ctx.env, session.accessToken)

    const originalFetch = globalThis.fetch
    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("http://spaces-verifier.test/inspect?")) {
        return new Response(JSON.stringify({
          root_exists: true,
          root_key_proof_verified: true,
          root_pubkey: "spaces-root-pubkey",
          observation_provider: "spaces_verifier",
          anchor_fresh_enough: true,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url === "http://spaces-verifier.test/verify-signature") {
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
        root_label: "@pirate-restart-root",
      }, ctx.env, session.accessToken)
      const createdBody = await json(createdNamespaceSession) as {
        namespace_verification_session_id: string
        challenge_payload?: { nonce?: string; digest?: string } | null
        expires_at: string
      }

      const completedNamespaceSession = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${createdBody.namespace_verification_session_id}/complete`,
        { signature_payload: { signature: "spaces-signature" } },
        ctx.env,
        session.accessToken,
      )
      const completedBody = await json(completedNamespaceSession) as {
        status: string
        namespace_verification_id: string | null
        evidence_bundle_ref: string | null
      }
      expect(completedBody.status).toBe("verified")
      expect(typeof completedBody.namespace_verification_id).toBe("string")
      expect(typeof completedBody.evidence_bundle_ref).toBe("string")

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
        challenge_payload?: { nonce?: string; digest?: string } | null
        expires_at: string
      }
      expect(restartedBody.status).toBe("challenge_required")
      expect(restartedBody.namespace_verification_id).toBeNull()
      expect(restartedBody.evidence_bundle_ref).toBeNull()
      expect(restartedBody.accepted_at).toBeNull()
      expect(restartedBody.challenge_payload?.nonce === createdBody.challenge_payload?.nonce).toBe(false)
      expect(restartedBody.challenge_payload?.digest === createdBody.challenge_payload?.digest).toBe(false)
      expect(new Date(restartedBody.expires_at).getTime() > new Date(createdBody.expires_at).getTime()).toBe(true)
    })
  })

  test("spaces session start rejects missing root facts and derives capabilities from inspection", async () => {
    const ctx = await createRouteTestContext({
      SPACES_VERIFIER_BASE_URL: "http://spaces-verifier.test",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-spaces-start-guards-user")
    await createSelfVerifiedSession(ctx.env, session.accessToken)

    const originalFetch = globalThis.fetch
    let inspectMode: "missing_root" | "missing_pubkey" | "missing_proof" | "stale_anchor" = "missing_root"

    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("http://spaces-verifier.test/inspect?")) {
        if (inspectMode === "missing_root") {
          return new Response(JSON.stringify({
            root_exists: false,
            observation_provider: "spaces_verifier",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        if (inspectMode === "missing_pubkey") {
          return new Response(JSON.stringify({
            root_exists: true,
            root_key_proof_verified: true,
            root_pubkey: null,
            observation_provider: "spaces_verifier",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        return new Response(JSON.stringify({
          root_exists: true,
          root_key_proof_verified: inspectMode === "stale_anchor",
          root_pubkey: "spaces-root-pubkey",
          observation_provider: "spaces_verifier",
          anchor_fresh_enough: inspectMode === "stale_anchor" ? false : true,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url === "http://spaces-verifier.test/verify-signature") {
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
      const missingRootResponse = await requestJson("http://pirate.test/namespace-verification-sessions", {
        family: "spaces",
        root_label: "@pirate-missing-root",
      }, ctx.env, session.accessToken)
      expect(missingRootResponse.status).toBe(403)

      inspectMode = "missing_pubkey"
      const missingPubkeyResponse = await requestJson("http://pirate.test/namespace-verification-sessions", {
        family: "spaces",
        root_label: "@pirate-missing-pubkey",
      }, ctx.env, session.accessToken)
      expect(missingPubkeyResponse.status).toBe(403)

      inspectMode = "missing_proof"
      const missingProofResponse = await requestJson("http://pirate.test/namespace-verification-sessions", {
        family: "spaces",
        root_label: "@pirate-missing-proof",
      }, ctx.env, session.accessToken)
      expect(missingProofResponse.status).toBe(403)

      inspectMode = "stale_anchor"
      const createdNamespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
        family: "spaces",
        root_label: "@pirate-stale-anchor-root",
      }, ctx.env, session.accessToken)
      const createdBody = await json(createdNamespaceSession) as {
        namespace_verification_session_id: string
      }

      const completedNamespaceSession = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${createdBody.namespace_verification_session_id}/complete`,
        { signature_payload: { signature: "spaces-signature" } },
        ctx.env,
        session.accessToken,
      )
      const completedBody = await json(completedNamespaceSession) as {
        status: string
        capabilities?: {
          club_attach_allowed?: boolean | null
        } | null
        assertions?: {
          anchor_fresh_enough?: boolean | null
        } | null
      }
      expect(completedBody.status).toBe("verified")
      expect(completedBody.assertions?.anchor_fresh_enough).toBe(false)
      expect(completedBody.capabilities?.club_attach_allowed).toBe(false)
    })
  })
})
