import { describe, expect, test } from "bun:test"
import { inferMembershipGateFailureVerificationPolicy } from "../src/lib/verification/verification-policies"

describe("inferMembershipGateFailureVerificationPolicy", () => {
  test("returns very join policy for membership unique_human rules that require very", () => {
    const policy = inferMembershipGateFailureVerificationPolicy([
      {
        scope: "membership",
        gate_family: "identity_proof",
        gate_type: "unique_human",
        proof_requirements_json: JSON.stringify([
          {
            proof_type: "unique_human",
            accepted_providers: ["very"],
          },
        ]),
      },
    ])

    expect(policy).toEqual({
      policy_id: "policy_very_join_v1",
      provider: "very",
      verification_intent: "ucommunity_join",
    })
  })

  test("prefers self join policy when membership rules require document-backed self proofs", () => {
    const policy = inferMembershipGateFailureVerificationPolicy([
      {
        scope: "membership",
        gate_family: "identity_proof",
        gate_type: "unique_human",
        proof_requirements_json: JSON.stringify([
          {
            proof_type: "unique_human",
            accepted_providers: ["very"],
          },
        ]),
      },
      {
        scope: "membership",
        gate_family: "identity_proof",
        gate_type: "age_over_18",
        proof_requirements_json: null,
      },
    ])

    expect(policy).toEqual({
      policy_id: "policy_self_join_v1",
      provider: "self",
      verification_intent: "ucommunity_join",
    })
  })
})
