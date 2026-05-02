import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createRouteTestContext, json, resetRuntimeCaches } from "../../helpers"
import {
  createSelfVerifiedSession,
  exchangeJwt,
  requestJson,
  withFetchMock,
} from "./verification-test-helpers"
import { decodePublicNamespaceVerificationSessionId } from "../../../src/lib/public-ids"

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

describe("hns verification lifecycle routes", () => {
  test("namespace verification restart clears accepted metadata and renews session expiry", async () => {
    const ctx = await createRouteTestContext({
      HNS_VERIFIER_BASE_URL: "http://hns-verifier.test",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-hns-restart-user")
    await createSelfVerifiedSession(ctx.env, session.accessToken)

    const originalFetch = globalThis.fetch
    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("http://hns-verifier.test")) {
        if (url.includes("/inspect-public?")) {
          return new Response(JSON.stringify({
            root_exists: true,
            expiry_horizon_sufficient: true,
            routing_enabled: true,
            pirate_dns_authority_verified: true,
            control_class: "single_holder_root",
            operation_class: "pirate_delegated_namespace",
            observation_provider: "web3dns_json_doh",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        if (url.endsWith("/verify-txt-public")) {
          return new Response(JSON.stringify({
            verified: true,
            observation_provider: "web3dns_json_doh",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        if (url.endsWith("/ensure-zone")) {
          return new Response(JSON.stringify({
            root_label: "piraterestartroot",
            zone_name: "piraterestartroot.",
            zone_created: true,
            nameservers: ["ns1.pirate."],
            observation_provider: "powerdns_sqlite",
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
        id: string
        challenge_txt_value: string | null
        expires_at: string
      }

      const completedNamespaceSession = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${createdBody.id}/complete`,
        {},
        ctx.env,
        session.accessToken,
      )
      const completedBody = await json(completedNamespaceSession) as {
        status: string
        namespace_verification: string | null
        evidence_bundle_ref: string | null
        accepted_at: number | null
      }
      expect(completedBody.status).toBe("verified")
      expect(typeof completedBody.namespace_verification).toBe("string")
      expect(typeof completedBody.evidence_bundle_ref).toBe("string")
      expect(typeof completedBody.accepted_at).toBe("number")

      const restartedNamespaceSession = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${createdBody.id}/complete`,
        { restart_challenge: true },
        ctx.env,
        session.accessToken,
      )
      expect(restartedNamespaceSession.status).toBe(200)
      const restartedBody = await json(restartedNamespaceSession) as {
        status: string
        namespace_verification: string | null
        evidence_bundle_ref: string | null
        accepted_at: string | null
        failure_reason: string | null
        challenge_txt_value: string | null
        expires_at: string
      }
      expect(restartedBody.status).toBe("challenge_required")
      expect(restartedBody.namespace_verification).toBeNull()
      expect(restartedBody.evidence_bundle_ref).toBeNull()
      expect(restartedBody.accepted_at).toBeNull()
      expect(restartedBody.failure_reason).toBeNull()
      expect(restartedBody.challenge_txt_value !== createdBody.challenge_txt_value).toBe(true)
      expect(new Date(restartedBody.expires_at).getTime() >= new Date(createdBody.expires_at).getTime()).toBe(true)
    })
  })

  test("hns verification stays challenge_pending while TXT is still propagating and reuses the same challenge", async () => {
    const ctx = await createRouteTestContext({
      HNS_VERIFIER_BASE_URL: "http://hns-verifier.test",
      HNS_CHALLENGE_TTL_HOURS: "24",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-hns-pending-user")
    await createSelfVerifiedSession(ctx.env, session.accessToken)

    let verifyCount = 0
    const originalFetch = globalThis.fetch
    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("http://hns-verifier.test")) {
        if (url.includes("/inspect-public?")) {
          return new Response(JSON.stringify({
            root_exists: true,
            expiry_horizon_sufficient: true,
            routing_enabled: true,
            pirate_dns_authority_verified: true,
            control_class: "single_holder_root",
            operation_class: "pirate_delegated_namespace",
            observation_provider: "web3dns_json_doh",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        if (url.endsWith("/verify-txt-public")) {
          verifyCount += 1
          return new Response(JSON.stringify(
            verifyCount === 1
              ? {
                  verified: false,
                  observed_values: [],
                  observation_provider: "web3dns_json_doh",
                }
              : {
                  verified: true,
                  observation_provider: "web3dns_json_doh",
                },
          ), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        if (url.endsWith("/ensure-zone")) {
          return new Response(JSON.stringify({
            root_label: "piratependingroot",
            zone_name: "piratependingroot.",
            zone_created: true,
            nameservers: ["ns1.pirate."],
            observation_provider: "powerdns_sqlite",
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
        root_label: "PiratePendingRoot",
      }, ctx.env, session.accessToken)
      expect(createdNamespaceSession.status).toBe(201)
      const createdBody = await json(createdNamespaceSession) as {
        id: string
        challenge_txt_value: string | null
      }

      const pendingCompletion = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${createdBody.id}/complete`,
        {},
        ctx.env,
        session.accessToken,
      )
      expect(pendingCompletion.status).toBe(200)
      const pendingBody = await json(pendingCompletion) as {
        status: string
        namespace_verification: string | null
        challenge_txt_value: string | null
        failure_reason: string | null
      }
      expect(pendingBody.status).toBe("challenge_pending")
      expect(pendingBody.namespace_verification).toBeNull()
      expect(pendingBody.challenge_txt_value).toBe(createdBody.challenge_txt_value)
      expect(pendingBody.failure_reason).toBeNull()

      const verifiedCompletion = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${createdBody.id}/complete`,
        {},
        ctx.env,
        session.accessToken,
      )
      expect(verifiedCompletion.status).toBe(200)
      const verifiedBody = await json(verifiedCompletion) as {
        status: string
        namespace_verification: string | null
        challenge_txt_value: string | null
      }
      expect(verifiedBody.status).toBe("verified")
      expect(typeof verifiedBody.namespace_verification).toBe("string")
      expect(verifiedBody.challenge_txt_value).toBe(createdBody.challenge_txt_value)
    })
  })

  test("namespace verification expires stale sessions before verifier completion", async () => {
    const ctx = await createRouteTestContext({
      HNS_VERIFIER_BASE_URL: "http://hns-verifier.test",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-hns-expiry-user")
    await createSelfVerifiedSession(ctx.env, session.accessToken)

    const originalFetch = globalThis.fetch
    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("http://hns-verifier.test")) {
        if (url.includes("/inspect-public?")) {
          return new Response(JSON.stringify({
            root_exists: true,
            expiry_horizon_sufficient: true,
            pirate_dns_authority_verified: true,
            operation_class: "pirate_delegated_namespace",
            observation_provider: "web3dns_json_doh",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }      }

      return originalFetch(input, init)
    }, async () => {
      const createdNamespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
        family: "hns",
        root_label: "PirateExpiryRoot",
      }, ctx.env, session.accessToken)
      const createdBody = await json(createdNamespaceSession) as {
        id: string
      }

      await ctx.client.execute({
        sql: `
          UPDATE namespace_verification_sessions
          SET expires_at = ?2
          WHERE namespace_verification_session_id = ?1
        `,
        args: [decodePublicNamespaceVerificationSessionId(createdBody.id), new Date(Date.now() - 60_000).toISOString()],
      })

      const completedNamespaceSession = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${createdBody.id}/complete`,
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
})
