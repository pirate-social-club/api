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

const testDsRecords = [
  `49194 13 2 ${"05".repeat(32)}`,
  `49194 13 4 ${"15".repeat(48)}`,
]

function hnsParentObservation(rootLabel: string, challengeTxtValue: string, height: number, committed: boolean): Record<string, unknown> {
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
      ds_records: [],
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

describe("hns verification lifecycle routes", () => {
  test("namespace verification restart clears accepted metadata and renews session expiry", async () => {
    const ctx = await createRouteTestContext({
      HNS_VERIFIER_BASE_URL: "http://hns-verifier.test",
    })
    cleanup = ctx.cleanup

    const session = await exchangeJwt(ctx.env, "verification-hns-restart-user")
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
            control_class: "single_holder_root",
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
            "piraterestartroot",
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
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        if (url.endsWith("/publish-txt")) {
          challengeTxtValue = body?.challenge_txt_value ?? challengeTxtValue
          return new Response(JSON.stringify({
            root_label: "piraterestartroot",
            zone_name: "piraterestartroot.",
            challenge_name: "_pirate.piraterestartroot.",
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
          return Response.json(hnsAuthorityObservation("piraterestartroot"))
        }
        if (url.includes("/authority-health?")) {
          return new Response(JSON.stringify({
            root_label: "piraterestartroot",
            zone_name: "piraterestartroot.",
            challenge_name: "_pirate.piraterestartroot.",
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
        root_label: "PirateRestartRoot",
      }, ctx.env, session.accessToken)
      const createdBody = await json(createdNamespaceSession) as {
        id: string
        challenge_txt_value: string | null
        expires_at: string
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
            control_class: "single_holder_root",
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
            "piratependingroot",
            challengeTxtValue,
            parentObservationCount === 1 ? 1000 : parentObservationCount === 2 ? 1040 : 1080,
            parentObservationCount > 1,
          ))
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
                  ownership_source: "hns_parent_chain_txt",
                },
          ), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        if (url.endsWith("/publish-txt")) {
          challengeTxtValue = body?.challenge_txt_value ?? challengeTxtValue
          return new Response(JSON.stringify({
            root_label: "piratependingroot",
            zone_name: "piratependingroot.",
            challenge_name: "_pirate.piratependingroot.",
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
          return Response.json(hnsAuthorityObservation("piratependingroot"))
        }
        if (url.includes("/authority-health?")) {
          return new Response(JSON.stringify({
            root_label: "piratependingroot",
            zone_name: "piratependingroot.",
            challenge_name: "_pirate.piratependingroot.",
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
        root_label: "PiratePendingRoot",
      }, ctx.env, session.accessToken)
      expect(createdNamespaceSession.status).toBe(201)
      const createdBody = await json(createdNamespaceSession) as {
        id: string
        challenge_txt_value: string | null
      }

      const pendingCompletion = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${createdBody.id}/complete`,
        { acknowledged_resource_replacement: true },
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

      const postBoundaryPending = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${createdBody.id}/complete`,
        { acknowledged_resource_replacement: true },
        ctx.env,
        session.accessToken,
      )
      expect(postBoundaryPending.status).toBe(200)
      const postBoundaryPendingBody = await json(postBoundaryPending) as { status: string }
      expect(postBoundaryPendingBody.status).toBe("challenge_pending")

      const verifiedCompletion = await requestJson(
        `http://pirate.test/namespace-verification-sessions/${createdBody.id}/complete`,
        { acknowledged_resource_replacement: true },
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
            pirate_dns_authority_verified: true,
            operation_class: "pirate_delegated_namespace",
            observation_provider: "web3dns_json_doh",
          }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        }
        if (url.includes("/observe-root-parent?")) {
          return Response.json(hnsParentObservation(
            "pirateexpiryroot",
            challengeTxtValue,
            1000,
            false,
          ))
        }
        if (url.endsWith("/publish-txt")) {
          challengeTxtValue = body?.challenge_txt_value ?? challengeTxtValue
          return Response.json({
            root_label: "pirateexpiryroot",
            zone_name: "pirateexpiryroot.",
            zone_created: true,
            nameservers: ["ns1.pirate.", "ns2.pirate."],
            ds_records: testDsRecords,
            observation_provider: "powerdns_api",
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
