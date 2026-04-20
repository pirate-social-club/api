import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import app from "../src/index"
import { createRouteTestContext, json, resetRuntimeCaches } from "./helpers"
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

describe("spaces verification routes", () => {
  test("spaces namespace verification starts and completes with a signed challenge payload", async () => {
    const ctx = await createRouteTestContext({
      SPACES_VERIFIER_BASE_URL: "http://spaces-verifier.test",
      SPACES_VERIFIER_CHALLENGE_DOMAIN: "pirate.sc",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-spaces-user")

    await createSelfVerifiedSession(ctx.env, session.accessToken)
    let expectedDigest: string | null = null
    let expectedRootPubkey: string | null = null

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
          accepted_anchor_height: 42,
          accepted_anchor_block_hash: "block-hash",
          accepted_anchor_root_hash: "anchor-root",
          proof_root_hash: "proof-root",
          anchor_fresh_enough: true,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url === "http://spaces-verifier.test/verify-signature") {
        const body = JSON.parse(String(init?.body))
        expect(body.digest).toBe(expectedDigest)
        expect(body.signature).toBe("spaces-signature")
        expect(body.root_pubkey).toBe(expectedRootPubkey)
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
        challenge_payload: { digest?: string; root_pubkey?: string } | null
      }
      expect(createdBody.family).toBe("spaces")
      expect(createdBody.challenge_kind).toBe("schnorr_sign")
      expect(createdBody.challenge_payload?.root_pubkey).toBe("spaces-root-pubkey")
      expectedDigest = createdBody.challenge_payload?.digest ?? null
      expectedRootPubkey = createdBody.challenge_payload?.root_pubkey ?? null

      const completedNamespaceSession = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${createdBody.namespace_verification_session_id}/complete`,
        {
          signature_payload: {
            digest: "client-digest-ignored",
            signature: "spaces-signature",
            root_pubkey: "client-root-pubkey-ignored",
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
        assertions?: {
          root_key_proof_verified?: boolean | null
          live_signature_verified?: boolean | null
          anchor_fresh_enough?: boolean | null
        } | null
        capabilities?: {
          owner_signed_record_updates_allowed?: boolean | null
          pirate_subspace_issuance_allowed?: boolean | null
        } | null
      }
      expect(fetchedBody.assertions?.root_key_proof_verified).toBe(true)
      expect(fetchedBody.assertions?.live_signature_verified).toBe(true)
      expect(fetchedBody.assertions?.anchor_fresh_enough).toBe(true)
      expect(fetchedBody.capabilities?.owner_signed_record_updates_allowed).toBe(false)
      expect(fetchedBody.capabilities?.pirate_subspace_issuance_allowed).toBe(false)
    })
  })

  test("spaces completion verifies against the stored challenge and fails invalid signatures", async () => {
    const ctx = await createRouteTestContext({
      SPACES_VERIFIER_BASE_URL: "http://spaces-verifier.test",
      SPACES_VERIFIER_CHALLENGE_DOMAIN: "pirate.sc",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-spaces-invalid-sig-user")
    await createSelfVerifiedSession(ctx.env, session.accessToken)

    let expectedDigest: string | null = null
    let expectedRootPubkey: string | null = null
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
          anchor_fresh_enough: true,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      if (url === "http://spaces-verifier.test/verify-signature") {
        const body = JSON.parse(String(init?.body))
        expect(body.digest).toBe(expectedDigest)
        expect(body.root_pubkey).toBe(expectedRootPubkey)
        expect(body.signature).toBe("bad-signature")
        return new Response(JSON.stringify({
          valid_signature: false,
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
        root_label: "@pirate-invalid-sig-root",
      }, ctx.env, session.accessToken)
      const createdBody = await json(createdNamespaceSession) as {
        namespace_verification_session_id: string
        challenge_payload?: { digest?: string; root_pubkey?: string } | null
      }
      expectedDigest = createdBody.challenge_payload?.digest ?? null
      expectedRootPubkey = createdBody.challenge_payload?.root_pubkey ?? null

      const completedNamespaceSession = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${createdBody.namespace_verification_session_id}/complete`,
        {
          signature_payload: {
            digest: "ignored-digest",
            root_pubkey: "ignored-root-pubkey",
            signature: "bad-signature",
          },
        },
        ctx.env,
        session.accessToken,
      )
      expect(completedNamespaceSession.status).toBe(200)
      const completedBody = await json(completedNamespaceSession) as {
        status: string
        failure_reason: string | null
      }
      expect(completedBody.status).toBe("failed")
      expect(completedBody.failure_reason).toBe("invalid_signature")
    })
  })

  test("spaces completion marks wrong signer distinctly", async () => {
    const ctx = await createRouteTestContext({
      SPACES_VERIFIER_BASE_URL: "http://spaces-verifier.test",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-spaces-wrong-signer-user")
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
      if (url === "http://spaces-verifier.test/verify-signature") {
        return new Response(JSON.stringify({
          valid_signature: false,
          wrong_signer: true,
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
        root_label: "@pirate-wrong-signer-root",
      }, ctx.env, session.accessToken)
      const createdBody = await json(createdNamespaceSession) as {
        namespace_verification_session_id: string
      }

      const completedNamespaceSession = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${createdBody.namespace_verification_session_id}/complete`,
        {
          signature_payload: {
            signature: "spaces-signature",
            signer_pubkey: "different-pubkey",
          },
        },
        ctx.env,
        session.accessToken,
      )
      expect(completedNamespaceSession.status).toBe(200)
      const completedBody = await json(completedNamespaceSession) as {
        status: string
        failure_reason: string | null
      }
      expect(completedBody.status).toBe("failed")
      expect(completedBody.failure_reason).toBe("wrong_signer")
    })
  })

  test("spaces completion requires a signature payload", async () => {
    const ctx = await createRouteTestContext({
      SPACES_VERIFIER_BASE_URL: "http://spaces-verifier.test",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-spaces-missing-signature-user")
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
      const createdNamespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
        family: "spaces",
        root_label: "@pirate-missing-signature-root",
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
      expect(completedNamespaceSession.status).toBe(400)
    })
  })
})
