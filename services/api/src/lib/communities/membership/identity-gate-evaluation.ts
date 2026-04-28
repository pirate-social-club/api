import type { User } from "../../../types"
import { normalizeIdentityCountryCode } from "../../identity/country-codes"
import {
  includesAcceptedMechanism,
  includesAcceptedProvider,
  readExcludedCountryValues,
  readMinimumAge,
  readMinimumScore,
  readRequiredCountryValues,
} from "./gate-config"
import type {
  MembershipGateEvaluation,
  ProofRequirement,
  SuggestedVerificationProvider,
} from "./gate-types"

export function satisfiesMinimumAgeRequirement(
  user: User,
  acceptedProviders: string[] | null | undefined,
  minimumAge: number,
): boolean {
  const minimumAgeCapability = user.verification_capabilities.minimum_age
  if (
    minimumAgeCapability.state === "verified"
    && typeof minimumAgeCapability.value === "number"
    && minimumAgeCapability.value >= minimumAge
    && includesAcceptedProvider(acceptedProviders, minimumAgeCapability.provider)
  ) {
    return true
  }

  return minimumAge <= 18
    && user.verification_capabilities.age_over_18.state === "verified"
    && includesAcceptedProvider(acceptedProviders, user.verification_capabilities.age_over_18.provider)
}

export function satisfiesProofRequirement(
  user: User,
  requirement: ProofRequirement,
  gateConfig: Record<string, unknown> | null,
): boolean {
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
      if (capabilityValue && excludedValues.includes(capabilityValue)) {
        return false
      }
      return true
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
    case "sanctions_clear":
      return user.verification_capabilities.sanctions_clear.state === "verified"
        && includesAcceptedProvider(requirement.accepted_providers, user.verification_capabilities.sanctions_clear.provider)
        && includesAcceptedMechanism(requirement.accepted_mechanisms, user.verification_capabilities.sanctions_clear.mechanism)
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

export function evaluateIdentityProofRequirement(input: {
  user: User
  requirement: ProofRequirement
  gateConfig: Record<string, unknown> | null
  missingCapabilities: MembershipGateEvaluation["missingCapabilities"]
  mismatchReasons: string[]
  suggestedProvider: SuggestedVerificationProvider | null
}): SuggestedVerificationProvider | null {
  const { user, requirement } = input
  const config = (requirement.config ?? input.gateConfig ?? {}) as Record<string, unknown>
  let suggestedProvider = input.suggestedProvider

  switch (requirement.proof_type) {
    case "nationality": {
      const capability = user.verification_capabilities.nationality
      if (capability.state !== "verified") {
        input.missingCapabilities.push("nationality")
        if (includesAcceptedProvider(requirement.accepted_providers, "self")) {
          suggestedProvider = "self"
        }
      } else if (!includesAcceptedProvider(requirement.accepted_providers, capability.provider)) {
        input.mismatchReasons.push("provider_not_accepted")
      } else {
        const capabilityValue = normalizeIdentityCountryCode(capability.value)
        const requiredValues = readRequiredCountryValues(config)
        const excludedValues = readExcludedCountryValues(config)
        if (requiredValues.length > 0 && (!capabilityValue || !requiredValues.includes(capabilityValue))) {
          input.mismatchReasons.push("nationality_mismatch")
        }
        if (capabilityValue && excludedValues.includes(capabilityValue)) {
          input.mismatchReasons.push("nationality_excluded")
        }
      }
      break
    }
    case "unique_human": {
      const capability = user.verification_capabilities.unique_human
      if (capability.state !== "verified") {
        input.missingCapabilities.push("unique_human")
        if (includesAcceptedProvider(requirement.accepted_providers, "self")) {
          suggestedProvider = suggestedProvider ?? "self"
        }
        if (includesAcceptedProvider(requirement.accepted_providers, "very")) {
          suggestedProvider = suggestedProvider ?? "very"
        }
      } else if (!includesAcceptedProvider(requirement.accepted_providers, capability.provider)) {
        input.mismatchReasons.push("provider_not_accepted")
      }
      break
    }
    case "age_over_18": {
      if (!satisfiesMinimumAgeRequirement(user, requirement.accepted_providers, 18)) {
        input.missingCapabilities.push("age_over_18")
        if (includesAcceptedProvider(requirement.accepted_providers, "self")) {
          suggestedProvider = "self"
        }
      }
      break
    }
    case "minimum_age": {
      const minimumAge = readMinimumAge(config, null)
      if (minimumAge == null) {
        input.mismatchReasons.push("unsupported_gate_config")
      } else if (!satisfiesMinimumAgeRequirement(user, requirement.accepted_providers, minimumAge)) {
        const hasSomeAgeProof = user.verification_capabilities.minimum_age.state === "verified"
          || user.verification_capabilities.age_over_18.state === "verified"
        if (hasSomeAgeProof) {
          input.mismatchReasons.push("minimum_age_mismatch")
        } else {
          input.missingCapabilities.push("minimum_age")
          if (includesAcceptedProvider(requirement.accepted_providers, "self")) {
            suggestedProvider = "self"
          }
        }
      }
      break
    }
    case "gender": {
      const capability = user.verification_capabilities.gender
      if (capability.state !== "verified") {
        input.missingCapabilities.push("gender")
        if (includesAcceptedProvider(requirement.accepted_providers, "self")) {
          suggestedProvider = "self"
        }
      } else if (!includesAcceptedProvider(requirement.accepted_providers, capability.provider)) {
        input.mismatchReasons.push("provider_not_accepted")
      } else {
        const requiredValue = typeof config.required_value === "string" ? config.required_value : null
        if (requiredValue && capability.value !== requiredValue) {
          input.mismatchReasons.push("gender_mismatch")
        }
      }
      break
    }
    case "wallet_score": {
      const capability = user.verification_capabilities.wallet_score
      if (capability.state !== "verified") {
        input.missingCapabilities.push("wallet_score")
        if (includesAcceptedProvider(requirement.accepted_providers, "passport")) {
          suggestedProvider = suggestedProvider ?? "passport"
        }
      } else if (!includesAcceptedProvider(requirement.accepted_providers, capability.provider)) {
        input.mismatchReasons.push("provider_not_accepted")
      } else {
        const minimumScore = readMinimumScore(config, null)
        const scoreMeetsMinimum = minimumScore == null
          || (typeof capability.score === "number" && capability.score >= minimumScore)
        if (capability.passing_score !== true || !scoreMeetsMinimum) {
          input.mismatchReasons.push("wallet_score_too_low")
        }
      }
      break
    }
    case "sanctions_clear": {
      const capability = user.verification_capabilities.sanctions_clear
      if (capability.state !== "verified") {
        input.missingCapabilities.push("sanctions_clear")
        if (includesAcceptedProvider(requirement.accepted_providers, "self")) {
          suggestedProvider = suggestedProvider ?? "self"
        } else if (includesAcceptedProvider(requirement.accepted_providers, "passport")) {
          suggestedProvider = suggestedProvider ?? "passport"
        }
      } else if (!includesAcceptedProvider(requirement.accepted_providers, capability.provider)) {
        input.mismatchReasons.push("provider_not_accepted")
      } else if (!includesAcceptedMechanism(requirement.accepted_mechanisms, capability.mechanism)) {
        input.mismatchReasons.push("mechanism_not_accepted")
      }
      break
    }
    default:
      if (!satisfiesProofRequirement(user, requirement, input.gateConfig)) {
        input.mismatchReasons.push(`unsatisfied:${requirement.proof_type}`)
      }
  }

  return suggestedProvider
}
