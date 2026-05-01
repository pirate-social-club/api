import { afterEach, describe, expect, test } from "bun:test"
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

    if (sql.includes("INSERT INTO namespace_verification_sessions")) {
      this.insertAttempts += 1
      const args = typeof statement === "string" ? [] : (statement.args ?? [])
      expect(args[5]).toBe("challenge_required")
      expect(args[6]).toBe("dns_txt")
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
          challenge_payload_json: null,
          challenge_host: "_pirate.clawitzer",
          challenge_txt_value: "pirate-verification=nvs_test",
          setup_nameservers_json: JSON.stringify(["ns1.pirate."]),
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
  test("starts HNS sessions with nameserver and TXT records before delegation is detected", async () => {
    const calls: string[] = []
    globalThis.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input.toString()
      calls.push(`${init?.method ?? "GET"} ${url}`)

      if (url.includes("/inspect-public?") && calls.filter((entry) => entry.includes("/inspect-public?")).length === 1) {
        return new Response(JSON.stringify({
          root_exists: null,
          root_control_verified: null,
          expiry_horizon_sufficient: null,
          routing_enabled: null,
          pirate_dns_authority_verified: false,
          nameservers: ["ns1.pirate."],
          observation_provider: "web3dns_json_doh",
          failure_reason: "zone_not_provisioned",
          control_class: null,
          operation_class: null,
        }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }

      throw new Error(`unexpected fetch ${init?.method ?? "GET"} ${url}`)
    }

    const client = new PlatformManagedZoneBootstrapClient()
    const session = await startNamespaceVerificationSession(client, {
      ENVIRONMENT: "production",
      HNS_VERIFIER_BASE_URL: "https://spaces.pirate.sc/hns",
      HNS_VERIFIER_AUTH_TOKEN: "test-token",
    }, {
      userId: "usr_test",
      family: "hns",
      rootLabel: "clawitzer",
    })

    expect(client.insertAttempts).toBe(1)
    expect(session.status).toBe("challenge_required")
    expect(session.challenge_host).toBe("_pirate.clawitzer")
    expect(session.challenge_txt_value).toBe("pirate-verification=nvs_test")
    expect(session.setup_nameservers).toEqual(["ns1.pirate."])
    expect(calls).toEqual(["GET https://spaces.pirate.sc/hns/inspect-public?root_label=clawitzer&challenge_host=_pirate.clawitzer"])
  })
})
