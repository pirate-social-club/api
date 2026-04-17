import type { User, VerificationCapabilities } from "../../types"

export const INTERACTIVE_VERIFICATION_TTL_MS = 90 * 24 * 60 * 60 * 1000

function isExpiredAt(iso: string | null | undefined, nowMs: number): boolean {
  if (!iso) return false
  const expiresMs = Date.parse(iso)
  return Number.isFinite(expiresMs) && expiresMs <= nowMs
}

function isOlderThanTtl(verifiedAt: string | null | undefined, ttlMs: number, nowMs: number): boolean {
  if (!verifiedAt) return false
  const verifiedMs = Date.parse(verifiedAt)
  return Number.isFinite(verifiedMs) && verifiedMs + ttlMs <= nowMs
}

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

export function applyLazyCapabilityExpiry(
  capabilities: VerificationCapabilities,
  nowMs = Date.now(),
): VerificationCapabilities {
  const next: VerificationCapabilities = {
    unique_human: { ...capabilities.unique_human },
    age_over_18: { ...capabilities.age_over_18 },
    nationality: { ...capabilities.nationality },
    gender: { ...capabilities.gender },
    sanctions_clear: { ...capabilities.sanctions_clear },
    wallet_score: { ...capabilities.wallet_score },
  }

  if (
    next.unique_human.state === "verified"
    && (next.unique_human.provider === "self" || next.unique_human.provider === "very")
    && isOlderThanTtl(next.unique_human.verified_at, INTERACTIVE_VERIFICATION_TTL_MS, nowMs)
  ) {
    next.unique_human.state = "expired"
  }

  for (const capability of [next.age_over_18, next.nationality, next.gender] as const) {
    if (
      capability.state === "verified"
      && capability.provider === "self"
      && isOlderThanTtl(capability.verified_at, INTERACTIVE_VERIFICATION_TTL_MS, nowMs)
    ) {
      capability.state = "expired"
    }
  }

  if (
    next.sanctions_clear.state === "verified"
    && isOlderThanTtl(next.sanctions_clear.verified_at, INTERACTIVE_VERIFICATION_TTL_MS, nowMs)
  ) {
    next.sanctions_clear.state = "expired"
  }

  if (
    next.wallet_score.state === "verified"
    && isExpiredAt(next.wallet_score.expiration_timestamp, nowMs)
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
