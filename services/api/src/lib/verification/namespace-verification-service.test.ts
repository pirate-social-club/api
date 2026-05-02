import { describe, expect, test } from "bun:test"
import type { NamespaceVerificationSessionRow } from "../auth/auth-db-rows"
import type { Client, InStatement, QueryResult, Transaction } from "../sql-client"
import { completeNamespaceVerificationSession } from "./namespace-verification-service"

function makeHnsChallengeRow(
  overrides: Partial<NamespaceVerificationSessionRow> = {},
): NamespaceVerificationSessionRow {
  return {
    namespace_verification_session_id: "nvs_test",
    namespace_verification_id: null,
    user_id: "usr_test",
    family: "hns",
    submitted_root_label: "random",
    normalized_root_label: "random",
    status: "challenge_required",
    challenge_kind: "dns_txt",
    challenge_payload_json: null,
    challenge_host: "_pirate.random",
    challenge_txt_value: "pirate-verification=nvs_test",
    setup_nameservers_json: null,
    challenge_expires_at: "2026-05-30T00:00:00.000Z",
    root_exists: null,
    root_control_verified: null,
    expiry_horizon_sufficient: null,
    routing_enabled: null,
    pirate_dns_authority_verified: null,
    root_key_proof_verified: null,
    fabric_publish_verified: null,
    anchor_fresh_enough: null,
    owner_signed_updates_verified: null,
    club_attach_allowed: null,
    pirate_web_routing_allowed: null,
    pirate_subdomain_issuance_allowed: null,
    owner_signed_record_updates_allowed: null,
    pirate_subspace_issuance_allowed: null,
    control_class: null,
    operation_class: null,
    observation_provider: null,
    evidence_bundle_ref: null,
    failure_reason: null,
    accepted_at: null,
    anchor_height: null,
    anchor_block_hash: null,
    anchor_root_hash: null,
    proof_root_hash: null,
    expires_at: "2026-05-30T00:00:00.000Z",
    created_at: "2026-04-30T00:00:00.000Z",
    updated_at: "2026-04-30T00:00:00.000Z",
    ...overrides,
  }
}

class HnsCompleteClient implements Client {
  readonly row: NamespaceVerificationSessionRow
  batchCalls = 0

  constructor(row: NamespaceVerificationSessionRow) {
    this.row = row
  }

  async execute(statement: InStatement | string): Promise<QueryResult> {
    const sql = typeof statement === "string" ? statement : statement.sql

    if (sql.includes("FROM namespace_verification_sessions AS nvs")) {
      return { rows: [this.row] }
    }

    if (sql.includes("UPDATE namespace_verification_sessions")) {
      const args = typeof statement === "string" ? [] : statement.args
      if (sql.includes("status = 'challenge_pending'")) {
        this.row.status = "challenge_pending"
        this.row.failure_reason = "provider_unavailable"
        this.row.updated_at = String(args?.[1] ?? "")
        return { rows: [] }
      }
    }

    throw new Error(`unexpected SQL: ${sql}`)
  }

  async batch(): Promise<QueryResult[]> {
    this.batchCalls += 1
    throw new Error("batch should not run without an HNS verifier")
  }

  async transaction(): Promise<Transaction> {
    throw new Error("transaction not implemented for this test")
  }
}

describe("completeNamespaceVerificationSession", () => {
  test("does not locally accept HNS TXT challenges when the verifier is not configured", async () => {
    const client = new HnsCompleteClient(makeHnsChallengeRow())

    let error: unknown = null
    try {
      await completeNamespaceVerificationSession(client, { ENVIRONMENT: "development" }, {
        namespaceVerificationSessionId: "nvs_test",
        userId: "usr_test",
      })
    } catch (caught) {
      error = caught
    }

    expect(error).toMatchObject({
      code: "provider_unavailable",
      message: "HNS verifier is not configured",
    })
    expect(client.batchCalls).toBe(0)
  })

  test("keeps HNS challenges pending when the verifier is temporarily unavailable", async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "resolver unavailable" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    })) as never

    try {
      const client = new HnsCompleteClient(makeHnsChallengeRow())
      const result = await completeNamespaceVerificationSession(client, {
        ENVIRONMENT: "production",
        HNS_VERIFIER_BASE_URL: "https://verifier.pirate.sc/hns",
        HNS_VERIFIER_AUTH_TOKEN: "test-token",
      } as never, {
        namespaceVerificationSessionId: "nvs_test",
        userId: "usr_test",
      })

      expect(result?.status).toBe("challenge_pending")
      expect(result?.failure_reason).toBe("provider_unavailable")
      expect(client.batchCalls).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
