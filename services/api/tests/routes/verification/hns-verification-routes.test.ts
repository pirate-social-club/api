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

describe("hns verification routes", () => {
  test("namespace verification returns combined HNS NS and TXT records without publishing TXT", async () => {
    const ctx = await createRouteTestContext({
      HNS_VERIFIER_BASE_URL: "http://hns-verifier.test",
      HNS_VERIFIER_AUTH_TOKEN: "test-hns-token",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-hns-user")
    await createSelfVerifiedSession(ctx.env, session.accessToken)

    const calls: Array<{ url: string; body: unknown }> = []
    let inspectCount = 0
    const originalFetch = globalThis.fetch

    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("http://hns-verifier.test")) {
        const body = init?.body ? JSON.parse(String(init.body)) : null
        calls.push({ url, body })

        if (url.includes("/inspect-public?")) {
          inspectCount += 1
          return new Response(JSON.stringify({
            zone_exists: false,
            challenge_present: false,
            nameservers: ["ns1.pirate.sc."],
            observation_provider: "web3dns_json_doh",
            failure_reason: "zone_not_provisioned",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }

        if (url.endsWith("/verify-txt-public")) {
          return new Response(JSON.stringify({
            verified: true,
            observation_provider: "web3dns_json_doh",
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
        id: string
        status: string
        challenge_host: string | null
        challenge_txt_value: string | null
        setup_nameservers: string[] | null
        observation_provider: string | null
      }
      expect(namespaceSessionBody.status).toBe("challenge_required")
      expect(namespaceSessionBody.challenge_host).toBe("_pirate.pirateverifierroot")
      expect(typeof namespaceSessionBody.challenge_txt_value).toBe("string")
      expect(namespaceSessionBody.setup_nameservers).toEqual(["ns1.pirate.sc."])
      expect(namespaceSessionBody.observation_provider).toBe("web3dns_json_doh")
      expect(inspectCount).toBe(1)

      const fetchedNamespaceSession = await app.request(
        `http://pirate.test/namespace-verification-sessions/${namespaceSessionBody.id}`,
        {
          method: "GET",
          headers: {
            authorization: `Bearer ${session.accessToken}`,
          },
        },
        ctx.env,
      )
      expect(fetchedNamespaceSession.status).toBe(200)
      const fetchedNamespaceSessionBody = await json(fetchedNamespaceSession) as {
        status: string
        challenge_host: string | null
        challenge_txt_value: string | null
        setup_nameservers: string[] | null
      }
      expect(fetchedNamespaceSessionBody.status).toBe("challenge_required")
      expect(fetchedNamespaceSessionBody.challenge_host).toBe("_pirate.pirateverifierroot")
      expect(fetchedNamespaceSessionBody.challenge_txt_value).toBe(namespaceSessionBody.challenge_txt_value)
      expect(fetchedNamespaceSessionBody.setup_nameservers).toEqual(["ns1.pirate.sc."])
      expect(inspectCount).toBe(1)

      const completedNamespaceSession = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${namespaceSessionBody.id}/complete`,
        {},
        ctx.env,
        session.accessToken,
      )
      expect(completedNamespaceSession.status).toBe(200)
      const completedNamespaceBody = await json(completedNamespaceSession) as {
        status: string
        namespace_verification: string | null
        observation_provider: string | null
      }
      expect(completedNamespaceBody.status).toBe("verified")
      expect(typeof completedNamespaceBody.namespace_verification).toBe("string")
      expect(completedNamespaceBody.observation_provider).toBe("web3dns_json_doh")

      expect(calls.some((entry) => entry.url.includes("/inspect-public?"))).toBe(true)
      expect(calls.some((entry) => entry.url.endsWith("/verify-txt-public"))).toBe(true)
    })
  })

  test("namespace verification fails cleanly when the HNS verifier rejects the TXT proof", async () => {
    const ctx = await createRouteTestContext({
      HNS_VERIFIER_BASE_URL: "http://hns-verifier.test",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-hns-failure-user")
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
            operation_class: "pirate_delegated_namespace",
            observation_provider: "web3dns_json_doh",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        if (url.endsWith("/verify-txt-public")) {
          return new Response(JSON.stringify({
            verified: false,
            observation_provider: "web3dns_json_doh",
            failure_reason: "challenge_mismatch",
            observed_values: ["unexpected-value"],
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
        id: string
      }

      const completedNamespaceSession = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${namespaceSessionBody.id}/complete`,
        {},
        ctx.env,
        session.accessToken,
      )
      expect(completedNamespaceSession.status).toBe(200)
      const completedNamespaceBody = await json(completedNamespaceSession) as {
        status: string
        namespace_verification: string | null
        failure_reason: string | null
        observation_provider: string | null
      }
      expect(completedNamespaceBody.status).toBe("failed")
      expect(completedNamespaceBody.namespace_verification).toBeNull()
      expect(completedNamespaceBody.failure_reason).toBe("challenge_mismatch")
      expect(completedNamespaceBody.observation_provider).toBe("web3dns_json_doh")
    })
  })

  test("namespace verification preserves inspection-derived assertions on acceptance", async () => {
    const ctx = await createRouteTestContext({
      HNS_VERIFIER_BASE_URL: "http://hns-verifier.test",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-hns-assertions-user")
    await createSelfVerifiedSession(ctx.env, session.accessToken)

    const originalFetch = globalThis.fetch
    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("http://hns-verifier.test")) {
        if (url.includes("/inspect-public?")) {
          return new Response(JSON.stringify({
            root_exists: true,
            expiry_horizon_sufficient: false,
            routing_enabled: true,
            pirate_dns_authority_verified: true,
            control_class: "dao_controlled_root",
            operation_class: "routing_only_namespace",
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
      }

      return originalFetch(input, init)
    }, async () => {
      const createdNamespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
        family: "hns",
        root_label: "PirateAssertionsRoot",
      }, ctx.env, session.accessToken)
      const createdBody = await json(createdNamespaceSession) as {
        id: string
      }

      const completedNamespaceSession = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${createdBody.id}/complete`,
        {},
        ctx.env,
        session.accessToken,
      )
      const completedBody = await json(completedNamespaceSession) as {
        namespace_verification: string | null
      }
      expect(typeof completedBody.namespace_verification).toBe("string")

      const fetchedNamespaceVerification = await app.request(
        `http://pirate.test/namespace-verifications/${completedBody.namespace_verification}`,
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
