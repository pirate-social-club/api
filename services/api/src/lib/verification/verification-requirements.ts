import type {
  RequestedVerificationCapability,
  VerificationRequirement,
} from "../../types"

export function parseVerificationRequirements(raw: string | null | undefined): VerificationRequirement[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((requirement): VerificationRequirement[] => {
      if (requirement == null || typeof requirement !== "object") {
        return []
      }
      const typed = requirement as VerificationRequirement
      if (typed.proof_type === "sanctions_clear") {
        return [{ proof_type: "sanctions_clear" }]
      }
      if (typed.proof_type === "minimum_age" && Number.isInteger(typed.minimum_age)) {
        return [typed]
      }
      return []
    })
  } catch {
    return []
  }
}

export function resolveMinimumAgeToMint(
  requestedCapabilities: RequestedVerificationCapability[],
  verificationRequirements: VerificationRequirement[],
  selfClaims: { age_over_18: boolean; minimum_age?: number | null } | null | undefined,
): number | null {
  const candidates: number[] = []
  for (const requirement of verificationRequirements) {
    const minimumAge = requirement.minimum_age
    if (requirement.proof_type === "minimum_age" && typeof minimumAge === "number" && Number.isInteger(minimumAge)) {
      candidates.push(minimumAge)
    }
  }
  if (requestedCapabilities.includes("age_over_18")) {
    candidates.push(18)
  }
  if (selfClaims?.minimum_age != null) {
    candidates.push(selfClaims.minimum_age)
  }
  if (candidates.length === 0) {
    return null
  }
  return Math.max(...candidates)
}
