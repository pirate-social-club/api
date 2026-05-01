import { describe, expect, test } from "bun:test"
import { serializeNamespaceVerificationSession } from "../auth/auth-serializers"
import type { NamespaceVerificationSessionRow } from "../auth/auth-db-rows"
import {
  isDnsSetupRequiredNamespaceSessionRow,
  serializeNamespaceSessionStatus,
} from "./namespace-verification-policy"

function makeNamespaceSessionRow(
  overrides: Partial<NamespaceVerificationSessionRow> = {},
): NamespaceVerificationSessionRow {
  return {
    namespace_verification_session_id: "nvs_test",
    namespace_verification_id: null,
    user_id: "usr_test",
    family: "hns",
    submitted_root_label: "clawitzer",
    normalized_root_label: "clawitzer",
    status: "dns_setup_required",
    challenge_kind: null,
    challenge_payload_json: null,
    challenge_host: null,
    challenge_txt_value: null,
    setup_nameservers_json: JSON.stringify(["ns1.pirate."]),
    challenge_expires_at: null,
    root_exists: 1,
    root_control_verified: 1,
    expiry_horizon_sufficient: 1,
    routing_enabled: 1,
    pirate_dns_authority_verified: 0,
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
    failure_reason: "dns_setup_required",
    accepted_at: null,
    anchor_height: null,
    anchor_block_hash: null,
    anchor_root_hash: null,
    proof_root_hash: null,
    expires_at: "2026-05-27T00:00:00.000Z",
    created_at: "2026-04-27T00:00:00.000Z",
    updated_at: "2026-04-27T00:00:00.000Z",
    ...overrides,
  }
}

describe("namespace verification session status", () => {
  test("detects HNS DNS setup sessions", () => {
    const row = makeNamespaceSessionRow()

    expect(isDnsSetupRequiredNamespaceSessionRow(row)).toBe(true)
    expect(serializeNamespaceSessionStatus(row)).toBe("dns_setup_required")
  })

  test("does not alias active TXT challenge sessions", () => {
    const row = makeNamespaceSessionRow({
      status: "challenge_required",
      challenge_kind: "dns_txt",
      challenge_host: "_pirate.clawitzer",
      challenge_txt_value: "pirate-verification=nvs_test",
      failure_reason: null,
    })

    expect(isDnsSetupRequiredNamespaceSessionRow(row)).toBe(false)
    expect(serializeNamespaceSessionStatus(row)).toBe("challenge_required")
  })

  test("serializes HNS DNS setup sessions with setup nameservers", () => {
    const row = makeNamespaceSessionRow()

    expect(serializeNamespaceVerificationSession(row)).toMatchObject({
      status: "dns_setup_required",
      challenge_host: null,
      challenge_txt_value: null,
      setup_nameservers: ["ns1.pirate."],
    })
  })
})
