import type { User } from "../../../types"
import { normalizeIdentityCountryCode } from "../../identity/country-codes"
import {
  includesAcceptedProvider,
  parseGateConfig,
  parseProofRequirements,
  readExcludedCountryValues,
  readMinimumAge,
  readMinimumScore,
  readRequiredCountryValues,
  satisfiesMinimumAgeRequirement,
} from "./gate-config"
import type {
  CommunityGateRuleRow,
  MembershipGateEvaluation,
  ProofRequirement,
  SuggestedVerificationProvider,
} from "./gate-types"

function satisfiesProofRequirement(user: User, requirement: ProofRequirement, gateConfig: Record<string, unknown> | null): boolean {
  switch (requirement.proof_type) {
    case "unique_human":
      return user.verification_capabilities.unique_human.state === "verified"
        && includesAcceptedProvider(requirement.accepted_providers, user.verification_capabilities.unique_human.provider)
    case "age_over_18":
      return satisfiesMinimumAgeRequirement(user, requirement.accepted_providers, 18)
    case "minimum_age": {
      const config = (requirement.config ?? gateConfig ?? {}) as Record<string, unknown>
      const minimumAge = readMinimumAge(config, null)
      return minimumAge != null && satisfiesMinimumAgeRequirement(user, requirement.accepted_providers, minimumAge)
    }
    case "nationality": {
      const capability = user.verification_capabilities.nationality
      if (capability.state !== "verified" || !includesAcceptedProvider(requirement.accepted_providers, capability.provider)) {
        return false
      }
      const config = (requirement.config ?? gateConfig ?? {}) as Record<string, unknown>
      const capabilityValue = normalizeIdentityCountryCode(capability.value)
      const requiredValues = readRequiredCountryValues(config)
      const excludedValues = readExcludedCountryValues(config)
      if (requiredValues.length > 0 && (!capabilityValue || !requiredValues.includes(capabilityValue))) {
        return false
      }
      return !(capabilityValue && excludedValues.includes(capabilityValue))
    }
    case "gender": {
      const capability = user.verification_capabilities.gender
      if (capability.state !== "verified" || !includesAcceptedProvider(requirement.accepted_providers, capability.provider)) {
        return false
      }
      const config = (requirement.config ?? gateConfig ?? {}) as Record<string, unknown>
      const requiredValue = typeof config.required_value === "string" ? config.required_value : null
      return requiredValue ? capability.value === requiredValue : true
    }
    case "wallet_score": {
      const capability = user.verification_capabilities.wallet_score
      if (
        capability.state !== "verified"
        || capability.passing_score !== true
        || !includesAcceptedProvider(requirement.accepted_providers, capability.provider)
      ) {
        return false
      }
      const config = (requirement.config ?? gateConfig ?? {}) as Record<string, unknown>
      const minimumScore = typeof config.minimum_score === "number" ? config.minimum_score : null
      return minimumScore == null || (typeof capability.score === "number" && capability.score >= minimumScore)
    }
    default:
      return false
  }
}

export function evaluateIdentityGateRule(input: {
  rule: CommunityGateRuleRow
  user: User
  suggestedProvider: SuggestedVerificationProvider | null
}): Pick<MembershipGateEvaluation, "missingCapabilities" | "mismatchReasons" | "suggestedVerificationProvider"> {
  const gateConfig = parseGateConfig(input.rule.gate_config_json)
  const requirements = parseProofRequirements(input.rule.proof_requirements_json, input.rule.gate_type)
  const missingCapabilities: MembershipGateEvaluation["missingCapabilities"] = []
  const mismatchReasons: string[] = []
  let suggestedProvider = input.suggestedProvider

  for (const requirement of requirements) {
    const config = (requirement.config ?? gateConfig ?? {}) as Record<string, unknown>

    switch (requirement.proof_type) {
      case "nationality": {
        const capability = input.user.verification_capabilities.nationality
        if (capability.state !== "verified") {
          missingCapabilities.push("nationality")
          if (includesAcceptedProvider(requirement.accepted_providers, "self")) suggestedProvider = "self"
        } else if (!includesAcceptedProvider(requirement.accepted_providers, capability.provider)) {
          mismatchReasons.push("provider_not_accepted")
        } else {
          const capabilityValue = normalizeIdentityCountryCode(capability.value)
          const requiredValues = readRequiredCountryValues(config)
          const excludedValues = readExcludedCountryValues(config)
          if (requiredValues.length > 0 && (!capabilityValue || !requiredValues.includes(capabilityValue))) {
            mismatchReasons.push("nationality_mismatch")
          }
          if (capabilityValue && excludedValues.includes(capabilityValue)) {
            mismatchReasons.push("nationality_excluded")
          }
        }
        break
      }
      case "unique_human": {
        const capability = input.user.verification_capabilities.unique_human
        if (capability.state !== "verified") {
          missingCapabilities.push("unique_human")
          if (includesAcceptedProvider(requirement.accepted_providers, "very")) suggestedProvider = suggestedProvider ?? "very"
          if (includesAcceptedProvider(requirement.accepted_providers, "self")) suggestedProvider = suggestedProvider ?? "self"
        } else if (!includesAcceptedProvider(requirement.accepted_providers, capability.provider)) {
          mismatchReasons.push("provider_not_accepted")
        }
        break
      }
      case "age_over_18": {
        if (!satisfiesMinimumAgeRequirement(input.user, requirement.accepted_providers, 18)) {
          missingCapabilities.push("age_over_18")
          if (includesAcceptedProvider(requirement.accepted_providers, "self")) suggestedProvider = suggestedProvider ?? "self"
        }
        break
      }
      case "minimum_age": {
        const minimumAge = readMinimumAge(config, null)
        if (minimumAge == null) {
          mismatchReasons.push("unsupported_gate_config")
        } else if (!satisfiesMinimumAgeRequirement(input.user, requirement.accepted_providers, minimumAge)) {
          const hasSomeAgeProof = input.user.verification_capabilities.minimum_age.state === "verified"
            || input.user.verification_capabilities.age_over_18.state === "verified"
          if (hasSomeAgeProof) {
            mismatchReasons.push("minimum_age_mismatch")
          } else {
            missingCapabilities.push("minimum_age")
            if (includesAcceptedProvider(requirement.accepted_providers, "self")) suggestedProvider = suggestedProvider ?? "self"
          }
        }
        break
      }
      case "gender": {
        const capability = input.user.verification_capabilities.gender
        if (capability.state !== "verified") {
          missingCapabilities.push("gender")
          if (includesAcceptedProvider(requirement.accepted_providers, "self")) suggestedProvider = suggestedProvider ?? "self"
        } else if (!includesAcceptedProvider(requirement.accepted_providers, capability.provider)) {
          mismatchReasons.push("provider_not_accepted")
        } else if (typeof config.required_value === "string" && capability.value !== config.required_value) {
          mismatchReasons.push("gender_mismatch")
        }
        break
      }
      case "wallet_score": {
        const capability = input.user.verification_capabilities.wallet_score
        if (capability.state !== "verified") {
          missingCapabilities.push("wallet_score")
          if (includesAcceptedProvider(requirement.accepted_providers, "passport")) suggestedProvider = suggestedProvider ?? "passport"
        } else if (!includesAcceptedProvider(requirement.accepted_providers, capability.provider)) {
          mismatchReasons.push("provider_not_accepted")
        } else {
          const minimumScore = readMinimumScore(config, null)
          const scoreMeetsMinimum = minimumScore == null
            || (typeof capability.score === "number" && capability.score >= minimumScore)
          if (capability.passing_score !== true || !scoreMeetsMinimum) {
            mismatchReasons.push("wallet_score_too_low")
          }
        }
        break
      }
      default:
        if (!satisfiesProofRequirement(input.user, requirement, gateConfig)) {
          mismatchReasons.push(`unsatisfied:${requirement.proof_type}`)
        }
    }
  }

  return { missingCapabilities, mismatchReasons, suggestedVerificationProvider: suggestedProvider }
}
