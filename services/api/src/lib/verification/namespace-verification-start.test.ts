import { afterEach, describe, expect, test } from "bun:test"
import { mockFetch } from "../../test-helpers/fetch"
import type { Client, InStatement, QueryResult, Transaction } from "../sql-client"
import { startNamespaceVerificationSession } from "./namespace-verification-start"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

class PlatformManagedZoneBootstrapClient implements Client {
  insertAttempts = 0

  async execute(statement: InStatement | string): Promise<QueryResult> {
    const sql = typeof statement === "string" ? statement : statement.sql

    if (sql.includes("FROM users")) {
      throw new Error("namespace verification start must not require user verification capabilities")
    }

    if (sql.includes("INSERT INTO hns_import_session_locks")) {
      const args = typeof statement === "string" ? [] : (statement.args ?? [])
      expect(args[0]).toBe("clawitzer")
      return {
        rows: [{ namespace_verification_session_id: args[1] }],
        rowsAffected: 1,
      }
    }

    if (sql.includes("DELETE FROM hns_import_session_locks")) {
      return { rows: [], rowsAffected: 1 }
    }

    if (sql.includes("INSERT INTO namespace_verification_sessions")) {
      this.insertAttempts += 1
      const args = typeof statement === "string" ? [] : (statement.args ?? [])
      expect(args[5]).toBe("challenge_required")
      expect(args[6]).toBe("hns_import")
      expect(JSON.parse(String(args[7]))).toMatchObject({
        kind: "hns_import",
        publish_plan: {
          version: "hns_import_publish_v1",
          replacement_semantics: "complete_resource",
          acknowledgement_required: true,
        },
      })
      expect(typeof args[8]).toBe("string")
      expect(typeof args[9]).toBe("string")
      return { rows: [], rowsAffected: 1 }
    }

    if (sql.includes("FROM namespace_verification_sessions AS nvs")) {
      return {
        rows: [{
          namespace_verification_session_id: "nvs_test",
          namespace_verification_id: null,
          user_id: "usr_test",
          family: "hns",
          submitted_root_label: "clawitzer",
          normalized_root_label: "clawitzer",
          status: "challenge_required",
          challenge_kind: "dns_txt",
          challenge_payload_json: JSON.stringify({
            kind: "hns_import",
            publish_plan: { version: "hns_import_publish_v1" },
          }),
          challenge_host: "clawitzer",
          challenge_txt_value: "pirate-verification=nvs_test",
          setup_nameservers_json: JSON.stringify(["ns1.pirate.", "ns2.pirate."]),
          challenge_expires_at: "2026-04-28T00:00:00.000Z",
          root_exists: 1,
          root_control_verified: 1,
          expiry_horizon_sufficient: 1,
          routing_enabled: 1,
          pirate_dns_authority_verified: 1,
          root_key_proof_verified: null,
          fabric_publish_verified: null,
          anchor_fresh_enough: null,
          owner_signed_updates_verified: null,
          club_attach_allowed: null,
          pirate_web_routing_allowed: null,
          pirate_subdomain_issuance_allowed: null,
          owner_signed_record_updates_allowed: null,
          pirate_subspace_issuance_allowed: null,
          control_class: "single_holder_root",
          operation_class: "pirate_delegated_namespace",
          observation_provider: "web3dns_json_doh",
          evidence_bundle_ref: null,
          failure_reason: null,
          accepted_at: null,
          anchor_height: null,
          anchor_block_hash: null,
          anchor_root_hash: null,
          proof_root_hash: null,
          expires_at: "2026-05-27T00:00:00.000Z",
          created_at: "2026-04-27T00:00:00.000Z",
          updated_at: "2026-04-27T00:00:00.000Z",
        }],
      }
    }

    throw new Error(`unexpected SQL: ${sql}`)
  }

  async batch(): Promise<QueryResult[]> {
    throw new Error("batch not implemented for this test")
  }

  async transaction(): Promise<Transaction> {
    throw new Error("transaction not implemented for this test")
  }
}

describe("startNamespaceVerificationSession", () => {
  test("rejects namespace family and root prefix mismatches", async () => {
    const client = new PlatformManagedZoneBootstrapClient()

    await expect(startNamespaceVerificationSession(client, {}, {
      userId: "usr_test",
      family: "hns",
      rootLabel: "@clawitzer",
    })).rejects.toThrow("Namespace family must match root label prefix")

    await expect(startNamespaceVerificationSession(client, {}, {
      userId: "usr_test",
      family: "spaces",
      rootLabel: "clawitzer",
    })).rejects.toThrow("Namespace family must match root label prefix")
  })

  test("rejects platform-reserved HNS and Spaces roots after normalization", async () => {
    const client = new PlatformManagedZoneBootstrapClient()
    const reservedLabels = ["u", "g", "api", "auth", "settings", "admin"]

    for (const rootLabel of reservedLabels) {
      await expect(startNamespaceVerificationSession(client, {}, {
        userId: "usr_test",
        family: "hns",
        rootLabel: rootLabel.toUpperCase(),
      })).rejects.toThrow("Namespace root label is reserved by Pirate")

      await expect(startNamespaceVerificationSession(client, {}, {
        userId: "usr_test",
        family: "spaces",
        rootLabel: `@${rootLabel.toUpperCase()}`,
      })).rejects.toThrow("Namespace root label is reserved by Pirate")
    }

    expect(client.insertAttempts).toBe(0)
  })

  test("provisions a signed zone and returns one complete owner UPDATE before delegation", async () => {
    const calls: string[] = []
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      calls.push(`${init?.method ?? "GET"} ${url}`)

      if (url.includes("/inspect-public?") && calls.filter((entry) => entry.includes("/inspect-public?")).length === 1) {
        return new Response(JSON.stringify({
          root_exists: true,
          root_control_verified: null,
          expiry_horizon_sufficient: true,
          routing_enabled: null,
          pirate_dns_authority_verified: false,
          nameservers: ["ns1.pirate.", "ns2.pirate."],
          observation_provider: "web3dns_json_doh",
          failure_reason: "zone_not_provisioned",
          control_class: null,
          operation_class: null,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }

      if (url.includes("/observe-root-parent?")) {
        return Response.json({
          root_label: "clawitzer",
          zone_name: "clawitzer.",
          provider: "hsd_json_rpc",
          observed_at: "2026-04-27T00:00:00.000Z",
          chain_anchor: {
            network: "main",
            height: 1_000,
            block_hash: "ab".repeat(32),
            median_time: 1_700_000_000,
          },
          parent: {
            raw_records: [
              { type: "SYNTH4", address: "192.0.2.44" },
              { type: "TXT", txt: ["owner=", "alice"] },
            ],
            nameservers: [],
            ds_records: [],
            glue4: [],
            glue6: [],
          },
        })
      }

      if (url.endsWith("/publish-txt") && init?.method === "POST") {
        return Response.json({
          root_label: "clawitzer",
          zone_name: "clawitzer.",
          challenge_name: "_pirate.clawitzer.",
          challenge_txt_value: "pirate-verification=nvs_test",
          zone_created: true,
          nameservers: ["ns1.pirate.", "ns2.pirate."],
          ds_records: [
            `49194 13 2 ${"05".repeat(32)}`,
            `49194 13 4 ${"15".repeat(48)}`,
          ],
          observation_provider: "powerdns_api",
        })
      }

      throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`)
    })

    const client = new PlatformManagedZoneBootstrapClient()
    const session = await startNamespaceVerificationSession(client, {
      ENVIRONMENT: "production",
      HNS_VERIFIER_BASE_URL: "https://verifier.pirate.sc/hns",
      HNS_VERIFIER_AUTH_TOKEN: "test-token",
    }, {
      userId: "usr_test",
      family: "hns",
      rootLabel: "clawitzer",
    })

    expect(client.insertAttempts).toBe(1)
    expect(session.status).toBe("challenge_required")
    expect(session.challenge_host).toBe("clawitzer")
    expect(session.challenge_txt_value).toBe("pirate-verification=nvs_test")
    expect(session.setup_nameservers).toEqual(["ns1.pirate.", "ns2.pirate."])
    expect(session.challenge_payload).toMatchObject({
      kind: "hns_import",
      publish_plan: { version: "hns_import_publish_v1" },
    })
    expect(calls).toEqual([
      "GET https://verifier.pirate.sc/hns/inspect-public?root_label=clawitzer",
      "GET https://verifier.pirate.sc/hns/observe-root-parent?root_label=clawitzer",
      "POST https://verifier.pirate.sc/hns/publish-txt",
    ])
  })

  // Regression: production incident 2026-08-08. The deployed verifier predated
  // core#436 and omitted parent.raw_records, which surfaced as an untyped
  // TypeError (500) instead of a diagnosable contract failure.
  test("fails with verifier_contract_incompatible when observe-root-parent omits raw_records", async () => {
    let lockReleased = false
    globalThis.fetch = mockFetch(async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()

      if (url.includes("/inspect-public?")) {
        return Response.json({
          root_exists: true,
          root_control_verified: null,
          expiry_horizon_sufficient: true,
          routing_enabled: null,
          pirate_dns_authority_verified: false,
          nameservers: ["ns1.pirate.", "ns2.pirate."],
          observation_provider: "web3dns_json_doh",
          failure_reason: "zone_not_provisioned",
          control_class: null,
          operation_class: null,
        })
      }

      if (url.includes("/observe-root-parent?")) {
        return Response.json({
          root_label: "clawitzer",
          zone_name: "clawitzer.",
          provider: "hsd_json_rpc",
          observed_at: "2026-04-27T00:00:00.000Z",
          chain_anchor: {
            network: "main",
            height: 1_000,
            block_hash: "ab".repeat(32),
            median_time: 1_700_000_000,
          },
          parent: {
            nameservers: ["ns1.pirate."],
            ds_records: [],
            glue4: [],
            glue6: [],
          },
        })
      }

      if (url.endsWith("/publish-txt") && init?.method === "POST") {
        return Response.json({
          root_label: "clawitzer",
          zone_name: "clawitzer.",
          challenge_name: "_pirate.clawitzer.",
          challenge_txt_value: "pirate-verification=nvs_test",
          zone_created: true,
          nameservers: ["ns1.pirate.", "ns2.pirate."],
          ds_records: [
            `49194 13 2 ${"05".repeat(32)}`,
            `49194 13 4 ${"15".repeat(48)}`,
          ],
          observation_provider: "powerdns_api",
        })
      }

      throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`)
    })

    const client = new PlatformManagedZoneBootstrapClient()
    const originalExecute = client.execute.bind(client)
    client.execute = async (statement) => {
      const sql = typeof statement === "string" ? statement : statement.sql
      if (sql.includes("DELETE FROM hns_import_session_locks")) {
        lockReleased = true
      }
      return originalExecute(statement)
    }

    await expect(startNamespaceVerificationSession(client, {
      ENVIRONMENT: "production",
      HNS_VERIFIER_BASE_URL: "https://verifier.pirate.sc/hns",
      HNS_VERIFIER_AUTH_TOKEN: "test-token",
    }, {
      userId: "usr_test",
      family: "hns",
      rootLabel: "clawitzer",
    })).rejects.toThrow("observe-root-parent response is missing parent.raw_records")

    expect(client.insertAttempts).toBe(0)
    expect(lockReleased).toBe(true)
  })
})
