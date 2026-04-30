import type { User, VerificationCapabilities } from "../../types"

export const INTERACTIVE_VERIFICATION_TTL_MS = 90 * 24 * 60 * 60 * 1000

function isExpiredAt(unixSeconds: number | null | undefined, nowMs: number): boolean {
  if (typeof unixSeconds !== "number") return false
  return unixSeconds * 1000 <= nowMs
}

function isOlderThanTtl(verifiedAt: number | null | undefined, ttlMs: number, nowMs: number): boolean {
  if (typeof verifiedAt !== "number") return false
  const verifiedMs = verifiedAt * 1000
  return Number.isFinite(verifiedMs) && verifiedMs + ttlMs <= nowMs
}

export function buildDefaultVerificationCapabilities(): VerificationCapabilities {
  return {
    unique_human: { state: "unverified", provider: null, proof_type: null, mechanism: null, verified_at: null },
    age_over_18: { state: "unverified", provider: null, proof_type: null, mechanism: null, verified_at: null },
    minimum_age: { state: "unverified", value: null, provider: null, proof_type: null, mechanism: null, verified_at: null },
    nationality: { state: "unverified", value: null, provider: null, proof_type: null, mechanism: null, verified_at: null },
    gender: { state: "unverified", value: null, provider: null, proof_type: null, mechanism: null, verified_at: null },
    wallet_score: {
      state: "unverified",
      provider: null,
      proof_type: null,
      mechanism: null,
      verified_at: null,
      score_decimal: null,
      score_threshold_decimal: null,
      passing_score: null,
      last_scored_at: null,
      expires_at: null,
      stamps: null,
    },
  }
}

export function applyLazyCapabilityExpiry(
  capabilities: VerificationCapabilities,
  nowMs = Date.now(),
): VerificationCapabilities {
  const next: VerificationCapabilities = {
    unique_human: { ...capabilities.unique_human },
    age_over_18: { ...capabilities.age_over_18 },
    minimum_age: { ...capabilities.minimum_age },
    nationality: { ...capabilities.nationality },
    gender: { ...capabilities.gender },
    wallet_score: { ...capabilities.wallet_score },
  }

  if (
    next.unique_human.state === "verified"
    && (next.unique_human.provider === "self" || next.unique_human.provider === "very")
    && isOlderThanTtl(next.unique_human.verified_at, INTERACTIVE_VERIFICATION_TTL_MS, nowMs)
  ) {
    next.unique_human.state = "expired"
  }

  for (const capability of [next.age_over_18, next.minimum_age, next.nationality, next.gender] as const) {
    if (
      capability.state === "verified"
      && capability.provider === "self"
      && isOlderThanTtl(capability.verified_at, INTERACTIVE_VERIFICATION_TTL_MS, nowMs)
    ) {
      capability.state = "expired"
    }
  }

  if (
    next.wallet_score.state === "verified"
    && isExpiredAt(next.wallet_score.expires_at, nowMs)
  ) {
    next.wallet_score.state = "expired"
  }

  return next
}

export function deriveVerificationState(
  capabilities: VerificationCapabilities,
): User["verification_state"] {
  switch (capabilities.unique_human.state) {
    case "verified":
      return "verified"
    case "pending":
      return "pending"
    case "expired":
      return "reverification_required"
    case "unverified":
    default:
      return "unverified"
  }
}
