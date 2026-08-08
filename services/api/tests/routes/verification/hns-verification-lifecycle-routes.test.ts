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
            { type: "TXT", txt: ["owner=", "preserved"] },
            { type: "NS", ns: "ns1.pirate." },
            { type: "NS", ns: "ns2.pirate." },
            { type: "TXT", txt: [challengeTxtValue] },
            { type: "DS", keyTag: 49194, algorithm: 13, digestType: 2, digest: "05".repeat(32) },
            { type: "DS", keyTag: 49194, algorithm: 13, digestType: 4, digest: "15".repeat(48) },
          ]
        : [
            { type: "SYNTH4", address: "192.0.2.44" },
            { type: "TXT", txt: ["owner=", "preserved"] },
          ],
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
  test("rejects a camelCase restart field instead of treating it as plain completion", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "verification-hns-restart-typo-user")

    const response = await requestJson(
      "http://pirate.test/namespace-verification-sessions/nvs_missing/complete",
      { restartChallenge: true },
      ctx.env,
      session.accessToken,
    )
    expect(response.status).toBe(400)
    expect(await json(response)).toMatchObject({ code: "bad_request" })
  })

  test("keeps an expired HNS session terminal when completion omits restart_challenge", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "verification-hns-expired-plain-complete-user")
    const sessionId = "nvs_expired_plain_complete"
    const now = new Date().toISOString()
    await ctx.client.execute({
      sql: `
        INSERT INTO namespace_verification_sessions (
          namespace_verification_session_id, user_id, family,
          submitted_root_label, normalized_root_label, status,
          challenge_kind, expires_at, created_at, updated_at
        ) VALUES (?1, ?2, 'hns', 'expiredroot', 'expiredroot', 'expired',
                  'dns_txt', ?3, ?3, ?3)
      `,
      args: [sessionId, session.userId, now],
    })

    const response = await requestJson(
      `http://pirate.test/namespace-verification-sessions/${sessionId}/complete`,
      {},
      ctx.env,
      session.accessToken,
    )
    expect(response.status).toBe(200)
    expect(await json(response)).toMatchObject({
      status: "expired",
      challenge_kind: "dns_txt",
      challenge_payload: null,
    })
  })

  test("preserves the non-expired restart state gate", async () => {
    const ctx = await createRouteTestContext()
    cleanup = ctx.cleanup
    const session = await exchangeJwt(ctx.env, "verification-hns-nonexpired-restart-user")
    const sessionId = "nvs_nonexpired_restart"
    const now = new Date().toISOString()
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    await ctx.client.execute({
      sql: `
        INSERT INTO namespace_verification_sessions (
          namespace_verification_session_id, user_id, family,
          submitted_root_label, normalized_root_label, status,
          challenge_kind, expires_at, created_at, updated_at
        ) VALUES (?1, ?2, 'hns', 'pendingroot', 'pendingroot', 'challenge_pending',
                  'hns_import', ?3, ?4, ?4)
      `,
      args: [sessionId, session.userId, expiresAt, now],
    })

    const response = await requestJson(
      `http://pirate.test/namespace-verification-sessions/${sessionId}/complete`,
      { restart_challenge: true },
      ctx.env,
      session.accessToken,
    )
    expect(response.status).toBe(409)
    expect(await json(response)).toMatchObject({ code: "conflict" })
  })

  test("HNS restart rebuilds a complete import plan with fresh chain and challenge evidence", async () => {
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
        challenge_payload: {
          publish_plan: { replacement_records: Array<Record<string, unknown>> }
        }
        expires_at: string
      }
      const internalSessionId = decodePublicNamespaceVerificationSessionId(createdBody.id)
      await ctx.client.execute({
        sql: `
          UPDATE namespace_verification_sessions
          SET status = 'expired',
              challenge_kind = 'dns_txt',
              challenge_payload_json = NULL,
              anchor_height = 7,
              anchor_block_hash = 'stale-anchor'
          WHERE namespace_verification_session_id = ?1
        `,
        args: [internalSessionId],
      })

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
        challenge_kind: string | null
        challenge_payload: {
          kind: string
          observed_chain_anchor: { height: number; block_hash: string }
          publish_plan: {
            current_records: Array<Record<string, unknown>>
            replacement_records: Array<Record<string, unknown>>
          }
        }
        expires_at: string
      }
      expect(restartedBody.status).toBe("challenge_required")
      expect(restartedBody.namespace_verification).toBeNull()
      expect(restartedBody.evidence_bundle_ref).toBeNull()
      expect(restartedBody.accepted_at).toBeNull()
      expect(restartedBody.failure_reason).toBeNull()
      expect(restartedBody.challenge_kind).toBe("hns_import")
      expect(restartedBody.challenge_txt_value !== createdBody.challenge_txt_value).toBe(true)
      expect(restartedBody.challenge_txt_value).toStartWith("pirate-verification=nch_")
      expect(restartedBody.challenge_payload.kind).toBe("hns_import")
      expect(restartedBody.challenge_payload.observed_chain_anchor).toEqual({
        network: "main",
        height: 1040,
        block_hash: "ab".repeat(32),
        median_time: 1_786_000_000,
      })
      expect(restartedBody.challenge_payload.publish_plan.current_records).toContainEqual({
        type: "TXT",
        txt: ["owner=", "preserved"],
      })
      expect(restartedBody.challenge_payload.publish_plan.replacement_records).toContainEqual({
        type: "TXT",
        txt: ["owner=", "preserved"],
      })
      const createdDs = createdBody.challenge_payload.publish_plan.replacement_records
        .filter((record) => record.type === "DS")
      const restartedDs = restartedBody.challenge_payload.publish_plan.replacement_records
        .filter((record) => record.type === "DS")
      expect(restartedDs).toEqual(createdDs)
      expect(challengeTxtValue).toBe(restartedBody.challenge_txt_value)
      expect(new Date(restartedBody.expires_at).getTime() >= new Date(createdBody.expires_at).getTime()).toBe(true)
      const persisted = await ctx.client.execute({
        sql: `
          SELECT challenge_kind, challenge_payload_json, challenge_txt_value,
                 anchor_height, anchor_block_hash, failure_reason, accepted_at
          FROM namespace_verification_sessions
          WHERE namespace_verification_session_id = ?1
        `,
        args: [internalSessionId],
      })
      expect(persisted.rows[0]).toMatchObject({
        challenge_kind: "hns_import",
        challenge_txt_value: restartedBody.challenge_txt_value,
        anchor_height: 1040,
        anchor_block_hash: "ab".repeat(32),
        failure_reason: null,
        accepted_at: null,
      })
      expect(JSON.parse(String(persisted.rows[0]?.challenge_payload_json))).toEqual(restartedBody.challenge_payload)
      const lock = await ctx.client.execute({
        sql: `
          SELECT namespace_verification_session_id
          FROM hns_import_session_locks
          WHERE normalized_root_label = 'piraterestartroot'
        `,
      })
      expect(lock.rows).toEqual([{ namespace_verification_session_id: internalSessionId }])
    })
  })

  test("hns verification moves from pending to verified when the matching resource is observed", async () => {
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
            parentObservationCount > 2,
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
