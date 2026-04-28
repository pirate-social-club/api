import type { User } from "../../../types"
import { normalizeIdentityCountryCode, normalizeIdentityCountryCodes } from "../../identity/country-codes"
import { normalizeEthereumAddress } from "../community-token-gates"
import type { ProofRequirement } from "./gate-types"

export function parseProofRequirements(raw: string | null, fallbackGateType: string): ProofRequirement[] {
  if (!raw) {
    return [{ proof_type: fallbackGateType }]
  }
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed as ProofRequirement[] : [{ proof_type: fallbackGateType }]
  } catch {
    return [{ proof_type: fallbackGateType }]
  }
}

export function parseGateConfig(raw: string | null): Record<string, unknown> | null {
  if (!raw) {
    return null
  }
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

export function includesAcceptedProvider(acceptedProviders: string[] | null | undefined, provider: string | null | undefined): boolean {
  if (!acceptedProviders?.length) {
    return true
  }
  return provider != null && acceptedProviders.includes(provider)
}

export function readRequiredCountryValues(config: Record<string, unknown>): string[] {
  const values = new Set<string>()
  const singleRequiredValue = normalizeIdentityCountryCode(config.required_value)
  if (singleRequiredValue) {
    values.add(singleRequiredValue)
  }
  for (const value of normalizeIdentityCountryCodes(config.required_values)) {
    values.add(value)
  }
  return Array.from(values)
}

export function readExcludedCountryValues(config: Record<string, unknown>): string[] {
  return normalizeIdentityCountryCodes(config.excluded_values)
}

export function readMinimumAge(config: Record<string, unknown>, fallback: number | null): number | null {
  const value = config.minimum_age ?? config.required_minimum_age
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value
  }
  return fallback
}

export function readMinimumScore(config: Record<string, unknown>, fallback: number | null): number | null {
  const value = config.minimum_score
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value
  }
  return fallback
}

export function resolveTokenGateContractAddress(gateConfig: Record<string, unknown> | null): string | null {
  return normalizeEthereumAddress(gateConfig?.contract_address)
}

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
