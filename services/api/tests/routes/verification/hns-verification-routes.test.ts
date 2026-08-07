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

const testDsRecords = [
  `49194 13 2 ${"05".repeat(32)}`,
  `49194 13 4 ${"15".repeat(48)}`,
]

function hnsParentObservation(
  rootLabel: string,
  challengeTxtValue: string,
  height: number,
  committed: boolean,
): Record<string, unknown> {
  return {
    root_label: rootLabel,
    zone_name: `${rootLabel}.`,
    provider: "hnsd_json_rpc",
    observed_at: new Date().toISOString(),
    chain_anchor: {
      network: "main",
      height,
      block_hash: "ab".repeat(32),
      median_time: 1_786_000_000,
    },
    parent: {
      raw_records: committed
        ? [
            { type: "SYNTH4", address: "192.0.2.44" },
            { type: "NS", ns: "ns1.pirate." },
            { type: "NS", ns: "ns2.pirate." },
            { type: "TXT", txt: [challengeTxtValue] },
            { type: "DS", keyTag: 49194, algorithm: 13, digestType: 2, digest: "05".repeat(32) },
            { type: "DS", keyTag: 49194, algorithm: 13, digestType: 4, digest: "15".repeat(48) },
          ]
        : [{ type: "SYNTH4", address: "192.0.2.44" }],
      nameservers: committed ? ["ns1.pirate.", "ns2.pirate."] : [],
      ds_records: committed
        ? [
            { key_tag: 49194, algorithm: 13, digest_type: 2, digest: "05".repeat(32) },
            { key_tag: 49194, algorithm: 13, digest_type: 4, digest: "15".repeat(48) },
          ]
        : [],
      glue4: [],
      glue6: [],
    },
  }
}

function hnsAuthorityObservation(rootLabel: string): Record<string, unknown> {
  return {
    root_label: rootLabel,
    zone_name: `${rootLabel}.`,
    provider: "powerdns_api",
    observed_at: new Date().toISOString(),
    authoritative_dnssec_valid: true,
    parent_ds_matches_live_dnskey: true,
    earliest_rrsig_expires_at: "2099-01-01T00:00:00.000Z",
    parent: { raw_records: [], nameservers: [], ds_records: [] },
    parent_ds_results: [],
    authority_redundancy_ok: true,
    authorities: [],
    required_rrsets: [],
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
    let parentObservationCount = 0
    let challengeTxtValue = "pirate-verification=test"
    const originalFetch = globalThis.fetch

    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("http://hns-verifier.test")) {
        const body = init?.body ? JSON.parse(String(init.body)) : null
        calls.push({ url, body })

        if (url.includes("/inspect-public?")) {
          inspectCount += 1
          return new Response(JSON.stringify({
            root_exists: true,
            root_control_verified: true,
            expiry_horizon_sufficient: true,
            observation_provider: "web3dns_json_doh",
            operation_class: "pirate_delegated_namespace",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }

        if (url.includes("/observe-root-parent?")) {
          parentObservationCount += 1
          return Response.json(hnsParentObservation(
            "pirateverifierroot",
            challengeTxtValue,
            parentObservationCount === 1 ? 1000 : parentObservationCount === 2 ? 1040 : 1080,
            parentObservationCount > 1,
          ))
        }

        if (url.endsWith("/publish-txt") || url.endsWith("/ensure-zone")) {
          const requestBody = body as { challenge_txt_value?: string } | null
          challengeTxtValue = requestBody?.challenge_txt_value ?? challengeTxtValue
          return Response.json({
            root_label: "pirateverifierroot",
            zone_name: "pirateverifierroot.",
            challenge_name: "_pirate.pirateverifierroot.",
            zone_created: true,
            nameservers: ["ns1.pirate.", "ns2.pirate."],
            ds_records: testDsRecords,
            observation_provider: "powerdns_api",
          })
        }

        if (url.includes("/observe-root-authority?")) {
          return Response.json(hnsAuthorityObservation("pirateverifierroot"))
        }

        if (url.endsWith("/verify-txt-public")) {
          return new Response(JSON.stringify({
            verified: true,
            observation_provider: "web3dns_json_doh",
            root_exists: true,
            root_control_verified: true,
            expiry_horizon_sufficient: true,
            pirate_dns_authority_verified: true,
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
      expect(namespaceSessionBody.challenge_host).toBe("pirateverifierroot")
      expect(typeof namespaceSessionBody.challenge_txt_value).toBe("string")
      expect(namespaceSessionBody.setup_nameservers).toEqual(["ns1.pirate.", "ns2.pirate."])
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
      expect(fetchedNamespaceSessionBody.challenge_host).toBe("pirateverifierroot")
      expect(fetchedNamespaceSessionBody.challenge_txt_value).toBe(namespaceSessionBody.challenge_txt_value)
      expect(fetchedNamespaceSessionBody.setup_nameservers).toEqual(["ns1.pirate.", "ns2.pirate."])
      expect(inspectCount).toBe(1)

      const completedNamespaceSession = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${namespaceSessionBody.id}/complete`,
        { acknowledged_resource_replacement: true },
        ctx.env,
        session.accessToken,
      )
      expect(completedNamespaceSession.status).toBe(200)
      const pendingNamespaceBody = await json(completedNamespaceSession) as { status: string }
      expect(pendingNamespaceBody.status).toBe("challenge_pending")
      const verifiedNamespaceSession = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${namespaceSessionBody.id}/complete`,
        { acknowledged_resource_replacement: true },
        ctx.env,
        session.accessToken,
      )
      expect(verifiedNamespaceSession.status).toBe(200)
      const completedNamespaceBody = await json(verifiedNamespaceSession) as {
        status: string
        namespace_verification: string | null
        observation_provider: string | null
        ownership_source: string | null
        assertions: { authority_health_verified: boolean | null }
      }
      expect(completedNamespaceBody.status).toBe("verified")
      expect(typeof completedNamespaceBody.namespace_verification).toBe("string")
      expect(completedNamespaceBody.observation_provider).toBe("web3dns_json_doh")
      expect(completedNamespaceBody.ownership_source).toBeNull()
      expect(completedNamespaceBody.assertions.authority_health_verified).toBeNull()

      expect(calls.some((entry) => entry.url.includes("/inspect-public?"))).toBe(true)
      expect(calls.some((entry) => entry.url.includes("/observe-root-parent?"))).toBe(true)
      expect(calls.some((entry) => entry.url.endsWith("/verify-txt-public"))).toBe(true)
    })
  })

  test("namespace verification accepts equivalent Unicode and IDNA HNS root labels", async () => {
    const ctx = await createRouteTestContext({
      HNS_VERIFIER_BASE_URL: "http://hns-verifier.test",
      HNS_VERIFIER_AUTH_TOKEN: "test-hns-token",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-hns-idna-user")
    await createSelfVerifiedSession(ctx.env, session.accessToken)

    const capturedInspectUrls: string[] = []
    let parentObservationCount = 0
    let challengeTxtValue = "pirate-verification=test"
    const originalFetch = globalThis.fetch
    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("http://hns-verifier.test")) {
        const body = init?.body ? JSON.parse(String(init.body)) as { challenge_txt_value?: string } : null
        if (url.includes("/inspect-public?")) {
          capturedInspectUrls.push(url)
          return Response.json({
            root_exists: true,
            root_control_verified: true,
            expiry_horizon_sufficient: true,
            observation_provider: "web3dns_json_doh",
          })
        }
        if (url.includes("/observe-root-parent?")) {
          parentObservationCount += 1
          return Response.json(hnsParentObservation(
            "xn--pokmon-dva",
            challengeTxtValue,
            parentObservationCount,
            false,
          ))
        }
        if (url.endsWith("/publish-txt") || url.endsWith("/ensure-zone")) {
          challengeTxtValue = body?.challenge_txt_value ?? challengeTxtValue
          return Response.json({
            root_label: "xn--pokmon-dva",
            zone_name: "xn--pokmon-dva.",
            zone_created: true,
            nameservers: ["ns1.pirate.", "ns2.pirate."],
            ds_records: testDsRecords,
            observation_provider: "powerdns_api",
          })
        }
        return Response.json(hnsAuthorityObservation("xn--pokmon-dva"))
      }

      return originalFetch(input, init)
    }, async () => {
      for (const rootLabel of ["pokémon", "xn--pokmon-dva"]) {
        const createdNamespaceSession = await requestJson("http://pirate.test/namespace-verification-sessions", {
          family: "hns",
          root_label: rootLabel,
        }, ctx.env, session.accessToken)
        expect(createdNamespaceSession.status).toBe(201)
        const namespaceSessionBody = await json(createdNamespaceSession) as {
          normalized_root_label: string | null
          challenge_host: string | null
        }
        expect(namespaceSessionBody.normalized_root_label).toBe("xn--pokmon-dva")
        expect(namespaceSessionBody.challenge_host).toBe("xn--pokmon-dva")
      }
      expect(capturedInspectUrls).toEqual([
        "http://hns-verifier.test/inspect-public?root_label=xn--pokmon-dva",
        "http://hns-verifier.test/inspect-public?root_label=xn--pokmon-dva",
      ])
    })
  })

  test("namespace verification fails cleanly when the HNS verifier rejects the TXT proof", async () => {
    const ctx = await createRouteTestContext({
      HNS_VERIFIER_BASE_URL: "http://hns-verifier.test",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-hns-failure-user")
    await createSelfVerifiedSession(ctx.env, session.accessToken)

    let parentObservationCount = 0
    let challengeTxtValue = "pirate-verification=test"
    const originalFetch = globalThis.fetch
    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("http://hns-verifier.test")) {
        const body = init?.body ? JSON.parse(String(init.body)) as { challenge_txt_value?: string } : null
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
        if (url.includes("/observe-root-parent?")) {
          parentObservationCount += 1
          return Response.json(hnsParentObservation(
            "pirateverifierfailroot",
            challengeTxtValue,
            parentObservationCount === 1 ? 1000 : parentObservationCount === 2 ? 1040 : 1080,
            parentObservationCount > 1,
          ))
        }
        if (url.endsWith("/publish-txt") || url.endsWith("/ensure-zone")) {
          challengeTxtValue = body?.challenge_txt_value ?? challengeTxtValue
          return Response.json({
            root_label: "pirateverifierfailroot",
            zone_name: "pirateverifierfailroot.",
            zone_created: true,
            nameservers: ["ns1.pirate.", "ns2.pirate."],
            ds_records: testDsRecords,
            observation_provider: "powerdns_api",
          })
        }
        if (url.includes("/observe-root-authority?")) {
          return Response.json(hnsAuthorityObservation("pirateverifierfailroot"))
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
        { acknowledged_resource_replacement: true },
        ctx.env,
        session.accessToken,
      )
      expect(completedNamespaceSession.status).toBe(200)
      const pendingNamespaceBody = await json(completedNamespaceSession) as { status: string }
      expect(pendingNamespaceBody.status).toBe("challenge_pending")
      const failedNamespaceSession = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${namespaceSessionBody.id}/complete`,
        { acknowledged_resource_replacement: true },
        ctx.env,
        session.accessToken,
      )
      expect(failedNamespaceSession.status).toBe(200)
      const completedNamespaceBody = await json(failedNamespaceSession) as {
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

    const verifierCalls: string[] = []
    let parentObservationCount = 0
    let challengeTxtValue = "pirate-verification=test"
    const originalFetch = globalThis.fetch
    await withFetchMock(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      if (url.startsWith("http://hns-verifier.test")) {
        verifierCalls.push(url)
        const body = init?.body ? JSON.parse(String(init.body)) as { challenge_txt_value?: string } : null
        if (url.includes("/inspect-public?")) {
          return new Response(JSON.stringify({
            root_exists: true,
            root_control_verified: true,
            expiry_horizon_sufficient: true,
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
        if (url.includes("/observe-root-parent?")) {
          parentObservationCount += 1
          return Response.json(hnsParentObservation(
            "pirateassertionsroot",
            challengeTxtValue,
            parentObservationCount === 1 ? 1000 : parentObservationCount === 2 ? 1040 : 1080,
            parentObservationCount > 1,
          ))
        }
        if (url.endsWith("/verify-txt-public")) {
          return new Response(JSON.stringify({
            verified: true,
            observation_provider: "web3dns_json_doh",
            ownership_source: "hns_parent_chain_txt",
            expiry_horizon_sufficient: false,
            expiry_height: 10_500,
            expiry_anchor_height: 10_000,
            expiry_anchor_block_hash: "ab".repeat(32),
            expiry_anchor_median_time: 1_786_000_000,
            expiry_chain_network: "main",
            expiry_blocks_remaining: 500,
            expiry_horizon_blocks: 1_000,
            expiry_observation_provider: "hsd_json_rpc",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        if (url.endsWith("/publish-txt")) {
          challengeTxtValue = body?.challenge_txt_value ?? challengeTxtValue
          return new Response(JSON.stringify({
            root_label: "pirateassertionsroot",
            zone_name: "pirateassertionsroot.",
            challenge_name: "_pirate.pirateassertionsroot.",
            zone_created: true,
            nameservers: ["ns1.pirate.", "ns2.pirate."],
            ds_records: testDsRecords,
            observation_provider: "powerdns_api",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        if (url.includes("/observe-root-authority?")) {
          return Response.json(hnsAuthorityObservation("pirateassertionsroot"))
        }
        if (url.includes("/authority-health?")) {
          return new Response(JSON.stringify({
            root_label: "pirateassertionsroot",
            zone_name: "pirateassertionsroot.",
            challenge_name: "_pirate.pirateassertionsroot.",
            zone_provisioned: true,
            challenge_present: true,
            challenge_served: true,
            nameservers: ["ns1.pirate."],
            observation_provider: "authoritative_dns",
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
        { acknowledged_resource_replacement: true },
        ctx.env,
        session.accessToken,
      )
      const pendingBody = await json(completedNamespaceSession) as { status: string }
      expect(pendingBody.status).toBe("challenge_pending")
      const verifiedNamespaceSession = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${createdBody.id}/complete`,
        { acknowledged_resource_replacement: true },
        ctx.env,
        session.accessToken,
      )
      const completedBody = await json(verifiedNamespaceSession) as {
        namespace_verification: string | null
        assertions: { authority_health_verified: boolean | null }
        ownership_source: string | null
      }
      expect(typeof completedBody.namespace_verification).toBe("string")
      expect(completedBody.assertions.authority_health_verified).toBe(true)
      expect(completedBody.ownership_source).toBe("hns_parent_chain_txt")

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
          authority_health_verified: boolean | null
        }
        capabilities: {
          club_attach_allowed: boolean | null
          pirate_web_routing_allowed: boolean | null
          pirate_subdomain_issuance_allowed: boolean | null
        }
        control_class: string | null
        operation_class: string | null
        ownership_source: string | null
      }
      expect(fetchedBody.assertions.root_exists).toBe(true)
      expect(fetchedBody.assertions.root_control_verified).toBe(true)
      expect(fetchedBody.assertions.expiry_horizon_sufficient).toBe(false)
      expect(fetchedBody.assertions.routing_enabled).toBe(true)
      expect(fetchedBody.assertions.pirate_dns_authority_verified).toBe(true)
      expect(fetchedBody.assertions.authority_health_verified).toBe(true)
      expect(fetchedBody.capabilities.club_attach_allowed).toBe(false)
      expect(fetchedBody.capabilities.pirate_web_routing_allowed).toBe(true)
      expect(fetchedBody.capabilities.pirate_subdomain_issuance_allowed).toBe(false)
      expect(fetchedBody.control_class).toBe("dao_controlled_root")
      expect(fetchedBody.operation_class).toBe("routing_only_namespace")
      expect(fetchedBody.ownership_source).toBe("hns_parent_chain_txt")
      expect(verifierCalls.some((url) => url.endsWith("/publish-txt"))).toBe(true)
      expect(verifierCalls.some((url) => url.includes("/authority-health?"))).toBe(true)

      const evidenceResult = await ctx.client.execute({
        sql: `
          SELECT resolver_path_json, raw_response_json
          FROM namespace_verification_evidence_bundles
          WHERE family = 'hns'
          ORDER BY created_at DESC
          LIMIT 1
        `,
      })
      const evidenceRow = evidenceResult.rows[0]
      expect(JSON.parse(String(evidenceRow?.resolver_path_json))).toEqual([
        "web3dns_json_doh",
        "hsd_json_rpc",
        "powerdns_api",
        "authoritative_dns",
      ])
      const rawEvidence = JSON.parse(String(evidenceRow?.raw_response_json)) as Record<string, unknown>
      expect(rawEvidence.expiry_height).toBe(10_500)
      expect(rawEvidence.expiry_observation_provider).toBe("hsd_json_rpc")
    })
  })
})
