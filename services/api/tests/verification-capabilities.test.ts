import { describe, expect, test } from "bun:test"

import { parseVerificationCapabilities, serializeUser } from "../src/lib/auth/auth-serializers"
import type { UserRow } from "../src/lib/auth/auth-db-rows"
import { INTERACTIVE_VERIFICATION_TTL_MS } from "../src/lib/verification/verification-capabilities"

describe("verification capability lifecycle", () => {
  test("lazily expires old interactive capabilities", () => {
    const oldVerifiedAt = new Date(Date.now() - INTERACTIVE_VERIFICATION_TTL_MS - 60_000).toISOString()
    const capabilities = parseVerificationCapabilities(JSON.stringify({
      unique_human: {
        state: "verified",
        provider: "self",
        proof_type: "unique_human",
        mechanism: "zk-nullifier",
        verified_at: oldVerifiedAt,
      },
      age_over_18: {
        state: "verified",
        provider: "self",
        proof_type: "age_over_18",
        mechanism: "zk-age",
        verified_at: oldVerifiedAt,
      },
      nationality: {
        state: "verified",
        value: "US",
        provider: "self",
        proof_type: "nationality",
        mechanism: "zk-nationality",
        verified_at: oldVerifiedAt,
      },
      gender: {
        state: "verified",
        value: "F",
        provider: "self",
        proof_type: "gender",
        mechanism: "zk-gender",
        verified_at: oldVerifiedAt,
      },
    }))

    expect(capabilities.unique_human.state).toBe("expired")
    expect(capabilities.age_over_18.state).toBe("expired")
    expect(capabilities.nationality.state).toBe("expired")
    expect(capabilities.gender.state).toBe("expired")
  })

  test("serializeUser derives reverification_required from expired unique_human", () => {
    const oldVerifiedAt = new Date(Date.now() - INTERACTIVE_VERIFICATION_TTL_MS - 60_000).toISOString()
    const row: UserRow = {
      user_id: "usr_test",
      primary_wallet_attachment_id: null,
      verification_state: "verified",
      capability_provider: "self",
      verification_capabilities_json: JSON.stringify({
        unique_human: {
          state: "verified",
          provider: "self",
          proof_type: "unique_human",
          mechanism: "zk-nullifier",
          verified_at: oldVerifiedAt,
        },
      }),
      verified_at: oldVerifiedAt,
      nationality: null,
      current_verification_session_id: null,
      created_at: oldVerifiedAt,
      updated_at: oldVerifiedAt,
    }

    const user = serializeUser(row)
    expect(user.verification_capabilities.unique_human.state).toBe("expired")
    expect(user.verification_state).toBe("reverification_required")
  })
})
