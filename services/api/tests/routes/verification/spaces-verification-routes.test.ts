import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { app } from "../../../src/index"
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

function spacesInspectResponse() {
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

describe("spaces verification routes", () => {
  test("spaces namespace verification starts and completes after Fabric publish verification", async () => {
    const ctx = await createRouteTestContext({
      SPACES_VERIFIER_BASE_URL: "http://spaces-verifier.test",
      SPACES_VERIFIER_CHALLENGE_DOMAIN: "pirate.sc",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-spaces-user")
    await createSelfVerifiedSession(ctx.env, session.accessToken)

    const originalFetch = globalThis.fetch
    let expectedTxtValue: string | null = null
    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("http://spaces-verifier.test/inspect?")) {
        return spacesInspectResponse()
      }
      if (url === "http://spaces-verifier.test/verify-publish") {
        const body = JSON.parse(String(init?.body)) as {
          root_label: string
          txt_key: string
          txt_value: string
          web_url: string
          freedom_url: string
        }
        expect(body.root_label).toBe("pirate-space-root")
        expect(body.txt_key).toBe("pirate-verify")
        expect(body.txt_value).toBe(expectedTxtValue)
        expect(body.web_url).toBe("https://pirate.sc/c/@pirate-space-root")
        expect(body.freedom_url).toBe("https://pirate.sc/c/@pirate-space-root")
        return new Response(JSON.stringify({
          fabric_publish_verified: true,
          root_key_proof_verified: true,
          web_target_verified: true,
          freedom_target_verified: true,
          observed_web_url: body.web_url,
          observed_freedom_url: body.freedom_url,
          observed_txt_values: [body.txt_value],
          records: {
            "pirate-verify": [body.txt_value],
            web: [body.web_url],
            freedom: [body.freedom_url],
          },
          observation_provider: "spaces_verifier+fabric_zone",
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
        challenge_payload: {
          root_pubkey?: string
          txt_key?: string
          txt_value?: string
          web_url?: string
          freedom_url?: string
        } | null
      }
      expect(createdBody.family).toBe("spaces")
      expect(createdBody.challenge_kind).toBe("fabric_txt_publish")
      expect(createdBody.challenge_payload?.root_pubkey).toBe("spaces-root-pubkey")
      expect(createdBody.challenge_payload?.txt_key).toBe("pirate-verify")
      expect(createdBody.challenge_payload?.txt_value).toContain("pirate-space-verify=nvs_")
      expect(createdBody.challenge_payload?.web_url).toBe("https://pirate.sc/c/@pirate-space-root")
      expectedTxtValue = createdBody.challenge_payload?.txt_value ?? null

      const completedNamespaceSession = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${createdBody.namespace_verification_session_id}/complete`,
        {},
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
          fabric_publish_verified?: boolean | null
          anchor_fresh_enough?: boolean | null
        } | null
        capabilities?: {
          owner_signed_record_updates_allowed?: boolean | null
          pirate_subspace_issuance_allowed?: boolean | null
        } | null
      }
      expect(fetchedBody.assertions?.root_key_proof_verified).toBe(true)
      expect(fetchedBody.assertions?.fabric_publish_verified).toBe(true)
      expect(fetchedBody.assertions?.anchor_fresh_enough).toBe(true)
      expect(fetchedBody.capabilities?.owner_signed_record_updates_allowed).toBe(false)
      expect(fetchedBody.capabilities?.pirate_subspace_issuance_allowed).toBe(false)
    })
  })

  test("spaces completion stays pending while Fabric records are not published", async () => {
    const ctx = await createRouteTestContext({
      SPACES_VERIFIER_BASE_URL: "http://spaces-verifier.test",
      SPACES_VERIFIER_CHALLENGE_DOMAIN: "pirate.sc",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-spaces-pending-user")
    await createSelfVerifiedSession(ctx.env, session.accessToken)

    const originalFetch = globalThis.fetch
    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("http://spaces-verifier.test/inspect?")) {
        return spacesInspectResponse()
      }
      if (url === "http://spaces-verifier.test/verify-publish") {
        return new Response(JSON.stringify({
          fabric_publish_verified: false,
          root_key_proof_verified: true,
          web_target_verified: false,
          freedom_target_verified: false,
          observed_txt_values: [],
          records: {},
          observation_provider: "spaces_verifier+fabric_zone",
          failure_reason: "pirate_verify_record_missing",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return originalFetch(input, init)
    }, async () => {
      const createdNamespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
        family: "spaces",
        root_label: "@pirate-pending-root",
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
      expect(completedNamespaceSession.status).toBe(200)
      const completedBody = await json(completedNamespaceSession) as {
        status: string
        failure_reason: string | null
      }
      expect(completedBody.status).toBe("challenge_pending")
      expect(completedBody.failure_reason).toBeNull()
    })
  })

  test("spaces completion fails when published Fabric records do not match the challenge", async () => {
    const ctx = await createRouteTestContext({
      SPACES_VERIFIER_BASE_URL: "http://spaces-verifier.test",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-spaces-mismatch-user")
    await createSelfVerifiedSession(ctx.env, session.accessToken)

    const originalFetch = globalThis.fetch
    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("http://spaces-verifier.test/inspect?")) {
        return spacesInspectResponse()
      }
      if (url === "http://spaces-verifier.test/verify-publish") {
        return new Response(JSON.stringify({
          fabric_publish_verified: false,
          root_key_proof_verified: true,
          web_target_verified: false,
          freedom_target_verified: true,
          observed_web_url: "https://example.com/",
          observed_freedom_url: "https://pirate.sc/c/@pirate-mismatch-root",
          observed_txt_values: ["pirate-space-verify=wrong"],
          records: {
            "pirate-verify": ["pirate-space-verify=wrong"],
          },
          observation_provider: "spaces_verifier+fabric_zone",
          failure_reason: "pirate_verify_record_mismatch",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return originalFetch(input, init)
    }, async () => {
      const createdNamespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
        family: "spaces",
        root_label: "@pirate-mismatch-root",
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
      expect(completedNamespaceSession.status).toBe(200)
      const completedBody = await json(completedNamespaceSession) as {
        status: string
        failure_reason: string | null
      }
      expect(completedBody.status).toBe("failed")
      expect(completedBody.failure_reason).toBe("pirate_verify_record_mismatch")
    })
  })

  test("spaces completion fails closed when verifier success conflicts with component checks", async () => {
    const ctx = await createRouteTestContext({
      SPACES_VERIFIER_BASE_URL: "http://spaces-verifier.test",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-spaces-inconsistent-user")
    await createSelfVerifiedSession(ctx.env, session.accessToken)

    const originalFetch = globalThis.fetch
    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("http://spaces-verifier.test/inspect?")) {
        return spacesInspectResponse()
      }
      if (url === "http://spaces-verifier.test/verify-publish") {
        const body = JSON.parse(String(init?.body)) as {
          txt_value: string
          web_url: string
          freedom_url: string
        }
        return new Response(JSON.stringify({
          fabric_publish_verified: true,
          root_key_proof_verified: true,
          web_target_verified: false,
          freedom_target_verified: true,
          observed_web_url: body.web_url,
          observed_freedom_url: body.freedom_url,
          observed_txt_values: [body.txt_value],
          records: {
            "pirate-verify": [body.txt_value],
          },
          observation_provider: "spaces_verifier+fabric_zone",
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      return originalFetch(input, init)
    }, async () => {
      const createdNamespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
        family: "spaces",
        root_label: "@pirate-inconsistent-root",
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
      expect(completedNamespaceSession.status).toBe(502)
      const completedBody = await json(completedNamespaceSession) as {
        code: string
      }
      expect(completedBody.code).toBe("provider_unavailable")

      const row = await ctx.client.execute({
        sql: `
          SELECT status, accepted_at
          FROM namespace_verification_sessions
          WHERE namespace_verification_session_id = ?1
        `,
        args: [createdBody.namespace_verification_session_id],
      })
      expect(row.rows[0]?.status).toBe("challenge_required")
      expect(row.rows[0]?.accepted_at).toBeNull()
    })
  })
})
