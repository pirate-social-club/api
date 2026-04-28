import { normalizeIdentityCountryCode, normalizeIdentityCountryCodes } from "../../identity/country-codes"
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

export function includesAcceptedProvider(
  acceptedProviders: string[] | null | undefined,
  provider: string | null | undefined,
): boolean {
  if (!acceptedProviders?.length) {
    return true
  }
  return provider != null && acceptedProviders.includes(provider)
}

function normalizeSanctionsMechanism(mechanism: string | null | undefined): string | null {
  if (mechanism === "CleanHands") {
    return "passport_clean_hands"
  }
  return typeof mechanism === "string" && mechanism.length > 0 ? mechanism : null
}

export function includesAcceptedMechanism(
  acceptedMechanisms: string[] | null | undefined,
  mechanism: string | null | undefined,
): boolean {
  if (!acceptedMechanisms?.length) {
    return true
  }
  const normalizedMechanism = normalizeSanctionsMechanism(mechanism)
  const normalizedAccepted = acceptedMechanisms.map((value) => normalizeSanctionsMechanism(value))
  return normalizedMechanism != null && normalizedAccepted.includes(normalizedMechanism)
}

export function readRequiredCountryValues(config: Record<string, unknown>): string[] {
  const values = new Set<string>()
  const legacyRequiredValue = normalizeIdentityCountryCode(config.required_value)
  if (legacyRequiredValue) {
    values.add(legacyRequiredValue)
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
