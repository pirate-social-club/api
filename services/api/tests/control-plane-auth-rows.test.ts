import { describe, expect, test } from "bun:test"
import {
  toNamespaceVerificationSessionRow,
  toUserRow,
  toVerificationSessionRow,
} from "../src/lib/auth/control-plane-auth-rows"

describe("control-plane auth row JSON normalization", () => {
  test("normalizes jsonb arrays for verification session rows", () => {
    const row = toVerificationSessionRow({
      verification_session_id: "ver_01",
      user_id: "usr_01",
      provider: "self",
      wallet_attachment_id: null,
      requested_capabilities_json: ["unique_human", "age_over_18"],
      verification_intent: "profile_verification",
      policy_id: "policy_self_profile_v1",
      status: "pending",
      upstream_session_ref: null,
      result_ref: null,
      failure_code: null,
      completed_at: null,
      expires_at: new Date("2026-04-13T00:00:00.000Z"),
      created_at: "2026-04-12T00:00:00.000Z",
      updated_at: "2026-04-12T00:00:00.000Z",
    })

    expect(row.requested_capabilities_json).toBe("[\"unique_human\",\"age_over_18\"]")
    expect(row.expires_at).toBe("2026-04-13T00:00:00.000Z")
  })

  test("normalizes jsonb objects for namespace verification session rows", () => {
    const row = toNamespaceVerificationSessionRow({
      namespace_verification_session_id: "nvs_01",
      namespace_verification_id: null,
      user_id: "usr_01",
      family: "hns",
      submitted_root_label: "pirate",
      normalized_root_label: "pirate",
      status: "challenge_required",
      challenge_host: null,
      challenge_txt_value: null,
      challenge_expires_at: null,
      challenge_kind: "dns_txt",
      challenge_payload_json: {
        challenge: "txt",
        token: "abc123",
      },
      root_exists: 1,
      root_control_verified: null,
      expiry_horizon_sufficient: null,
      routing_enabled: null,
      pirate_dns_authority_verified: null,
      club_attach_allowed: 1,
      pirate_web_routing_allowed: null,
      pirate_subdomain_issuance_allowed: null,
      control_class: null,
      operation_class: null,
      observation_provider: null,
      evidence_bundle_ref: null,
      failure_reason: null,
      accepted_at: null,
      expires_at: "2026-04-13T00:00:00.000Z",
      anchor_height: null,
      anchor_block_hash: null,
      anchor_root_hash: null,
      proof_root_hash: null,
      created_at: "2026-04-12T00:00:00.000Z",
      updated_at: "2026-04-12T00:00:00.000Z",
    })

    expect(row.challenge_payload_json).toBe("{\"challenge\":\"txt\",\"token\":\"abc123\"}")
  })

  test("normalizes jsonb objects for user rows", () => {
    const row = toUserRow({
      user_id: "usr_01",
      primary_wallet_attachment_id: null,
      verification_state: "verified",
      capability_provider: "self",
      verification_capabilities_json: {
        unique_human: {
          state: "verified",
          provider: "self",
          proof_type: "unique_human",
          mechanism: "self-sdk",
          verified_at: "2026-04-12T00:00:00.000Z",
        },
      },
      verified_at: "2026-04-12T00:00:00.000Z",
      nationality: null,
      current_verification_session_id: null,
      created_at: "2026-04-12T00:00:00.000Z",
      updated_at: "2026-04-12T00:00:00.000Z",
    })

    expect(JSON.parse(row.verification_capabilities_json)).toMatchObject({
      unique_human: {
        state: "verified",
      },
    })
  })
})
