import type { VerificationCapabilities } from "../../types"

export function buildDefaultVerificationCapabilities(): VerificationCapabilities {
  return {
    unique_human: { state: "unverified", provider: null, proof_type: null, mechanism: null, verified_at: null },
    age_over_18: { state: "unverified", provider: null, proof_type: null, mechanism: null, verified_at: null },
    nationality: { state: "unverified", value: null, provider: null, proof_type: null, mechanism: null, verified_at: null },
    gender: { state: "unverified", value: null, provider: null, proof_type: null, mechanism: null, verified_at: null },
    sanctions_clear: { state: "unverified", provider: null, proof_type: null, mechanism: null, verified_at: null },
    wallet_score: {
      state: "unverified",
      provider: null,
      proof_type: null,
      mechanism: null,
      verified_at: null,
      score: null,
      score_threshold: null,
      passing_score: null,
      last_score_timestamp: null,
      expiration_timestamp: null,
      stamps: null,
    },
  }
}
