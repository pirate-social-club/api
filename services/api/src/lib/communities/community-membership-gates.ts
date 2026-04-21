import type { Env, MembershipGateSummary, User, WalletAttachmentSummary } from "../../types"
import { normalizeIdentityCountryCode, normalizeIdentityCountryCodes } from "../identity/country-codes"
import { requiredString, rowValue, stringOrNull } from "../sql-row"
import {
  anyAttachedEthereumWalletOwnsErc721Collection,
  hasEthereumRpcConfig,
  normalizeEthereumAddress,
} from "./community-token-gates"

export type CommunityGateRuleRow = {
  gate_rule_id: string
  scope: "membership" | "viewer" | "posting"
  gate_family: "identity_proof" | "token_holding"
  gate_type: string
  proof_requirements_json: string | null
  chain_namespace: string | null
  gate_config_json: string | null
  status: "active" | "disabled"
}

type ProofRequirement = {
  proof_type: string
  accepted_providers?: string[] | null
  accepted_mechanisms?: string[] | null
  config?: Record<string, unknown> | null
}

export type MembershipGateEvaluation = {
  satisfied: boolean
  missingCapabilities: Array<"unique_human" | "age_over_18" | "minimum_age" | "nationality" | "gender">
  mismatchReasons: string[]
  suggestedVerificationProvider: "self" | "very" | null
}

export function toCommunityGateRuleRow(row: unknown): CommunityGateRuleRow {
  return {
    gate_rule_id: requiredString(row, "gate_rule_id"),
    scope: requiredString(row, "scope") as CommunityGateRuleRow["scope"],
    gate_family: requiredString(row, "gate_family") as CommunityGateRuleRow["gate_family"],
    gate_type: requiredString(row, "gate_type"),
    proof_requirements_json: stringOrNull(rowValue(row, "proof_requirements_json")),
    chain_namespace: stringOrNull(rowValue(row, "chain_namespace")),
    gate_config_json: stringOrNull(rowValue(row, "gate_config_json")),
    status: requiredString(row, "status") as CommunityGateRuleRow["status"],
  }
}

function parseProofRequirements(raw: string | null, fallbackGateType: string): ProofRequirement[] {
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

function parseGateConfig(raw: string | null): Record<string, unknown> | null {
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

function includesAcceptedProvider(acceptedProviders: string[] | null | undefined, provider: string | null | undefined): boolean {
  if (!acceptedProviders?.length) {
    return true
  }
  return provider != null && acceptedProviders.includes(provider)
}

function readRequiredCountryValues(config: Record<string, unknown>): string[] {
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

function readExcludedCountryValues(config: Record<string, unknown>): string[] {
  return normalizeIdentityCountryCodes(config.excluded_values)
}

function readMinimumAge(config: Record<string, unknown>, fallback: number | null): number | null {
  const value = config.minimum_age ?? config.required_minimum_age
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value
  }
  return fallback
}

function satisfiesMinimumAgeRequirement(
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

export async function satisfiesMembershipGateRules(input: {
  env: Env
  rules: CommunityGateRuleRow[]
  user: User
  walletAttachments: WalletAttachmentSummary[]
}): Promise<boolean> {
  return (await evaluateMembershipGateRules(input)).satisfied
}

function resolveTokenGateContractAddress(gateConfig: Record<string, unknown> | null): string | null {
  return normalizeEthereumAddress(gateConfig?.contract_address)
}

export function buildMembershipGateSummary(rule: CommunityGateRuleRow): MembershipGateSummary {
  const requirements = parseProofRequirements(rule.proof_requirements_json, rule.gate_type)
  const gateConfig = parseGateConfig(rule.gate_config_json)
  const primaryReq = requirements[0]

  const summary: MembershipGateSummary = {
    gate_type: rule.gate_type as MembershipGateSummary["gate_type"],
  }

  if (primaryReq?.accepted_providers?.length) {
    summary.accepted_providers = primaryReq.accepted_providers as MembershipGateSummary["accepted_providers"]
  }

  if (rule.gate_type === "nationality" || rule.gate_type === "gender" || rule.gate_type === "minimum_age") {
    const config = (primaryReq?.config ?? gateConfig ?? {}) as Record<string, unknown>
    if (rule.gate_type === "nationality") {
      const requiredValues = readRequiredCountryValues(config)
      if (requiredValues.length === 1) {
        summary.required_value = requiredValues[0]
      }
      if (requiredValues.length > 1) {
        summary.required_values = requiredValues
      }
      const excludedValues = readExcludedCountryValues(config)
      if (excludedValues.length > 0) {
        summary.excluded_values = excludedValues
      }
    } else if (rule.gate_type === "minimum_age") {
      const minimumAge = readMinimumAge(config, null)
      if (minimumAge != null) {
        summary.required_minimum_age = minimumAge
      }
    } else if (typeof config.required_value === "string") {
      summary.required_value = config.required_value
    }
  }

  if (rule.gate_type === "erc721_holding") {
    const contractAddress = resolveTokenGateContractAddress(gateConfig)
    if (contractAddress) {
      summary.contract_address = contractAddress
    }
    if (rule.chain_namespace) {
      summary.chain_namespace = rule.chain_namespace
    }
  }

  return summary
}

export async function evaluateMembershipGateRules(input: {
  env: Env
  rules: CommunityGateRuleRow[]
  user: User
  walletAttachments: WalletAttachmentSummary[]
}): Promise<MembershipGateEvaluation> {
  const { env, rules, user, walletAttachments } = input
  if (rules.length === 0) {
    return {
      satisfied: false,
      missingCapabilities: [],
      mismatchReasons: ["no_active_gate_rules"],
      suggestedVerificationProvider: null,
    }
  }

  const missingCapabilities: MembershipGateEvaluation["missingCapabilities"] = []
  const mismatchReasons: string[] = []
  let suggestedProvider: "self" | "very" | null = null

  for (const rule of rules) {
    if (rule.gate_family === "token_holding") {
      const gateConfig = parseGateConfig(rule.gate_config_json)
      if (rule.gate_type !== "erc721_holding") {
        mismatchReasons.push(`unsupported_gate_type:${rule.gate_type}`)
        continue
      }
      if ((rule.chain_namespace ?? null) !== "eip155:1") {
        mismatchReasons.push("unsupported_chain_namespace")
        continue
      }

      const contractAddress = resolveTokenGateContractAddress(gateConfig)
      if (!contractAddress) {
        mismatchReasons.push("unsupported_gate_config")
        continue
      }

      if (!hasEthereumRpcConfig(env)) {
        mismatchReasons.push("unsupported")
        continue
      }

      const holdsRequiredCollection = await anyAttachedEthereumWalletOwnsErc721Collection({
        contractAddress,
        env,
        walletAttachments,
      })
      if (!holdsRequiredCollection) {
        mismatchReasons.push("erc721_holding_required")
      }
      continue
    }
    if (rule.gate_family !== "identity_proof") {
      mismatchReasons.push(`unsupported_gate_family:${rule.gate_family}`)
      continue
    }

    const gateConfig = parseGateConfig(rule.gate_config_json)
    const requirements = parseProofRequirements(rule.proof_requirements_json, rule.gate_type)

    for (const requirement of requirements) {
      const config = (requirement.config ?? gateConfig ?? {}) as Record<string, unknown>

      switch (requirement.proof_type) {
        case "nationality": {
          const capability = user.verification_capabilities.nationality
          if (capability.state !== "verified") {
            missingCapabilities.push("nationality")
            if (includesAcceptedProvider(requirement.accepted_providers, "self")) {
              suggestedProvider = "self"
            }
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
          const capability = user.verification_capabilities.unique_human
          if (capability.state !== "verified") {
            missingCapabilities.push("unique_human")
            if (includesAcceptedProvider(requirement.accepted_providers, "self")) {
              suggestedProvider = suggestedProvider ?? "self"
            }
            if (includesAcceptedProvider(requirement.accepted_providers, "very")) {
              suggestedProvider = suggestedProvider ?? "very"
            }
          } else if (!includesAcceptedProvider(requirement.accepted_providers, capability.provider)) {
            mismatchReasons.push("provider_not_accepted")
          }
          break
        }
        case "age_over_18": {
          if (!satisfiesMinimumAgeRequirement(user, requirement.accepted_providers, 18)) {
            missingCapabilities.push("age_over_18")
            if (includesAcceptedProvider(requirement.accepted_providers, "self")) {
              suggestedProvider = suggestedProvider ?? "self"
            }
          }
          break
        }
        case "minimum_age": {
          const minimumAge = readMinimumAge(config, null)
          if (minimumAge == null) {
            mismatchReasons.push("unsupported_gate_config")
          } else if (!satisfiesMinimumAgeRequirement(user, requirement.accepted_providers, minimumAge)) {
            const hasSomeAgeProof = user.verification_capabilities.minimum_age.state === "verified"
              || user.verification_capabilities.age_over_18.state === "verified"
            if (hasSomeAgeProof) {
              mismatchReasons.push("minimum_age_mismatch")
            } else {
              missingCapabilities.push("minimum_age")
              if (includesAcceptedProvider(requirement.accepted_providers, "self")) {
                suggestedProvider = suggestedProvider ?? "self"
              }
            }
          }
          break
        }
        case "gender": {
          const capability = user.verification_capabilities.gender
          if (capability.state !== "verified") {
            missingCapabilities.push("gender")
            if (includesAcceptedProvider(requirement.accepted_providers, "self")) {
              suggestedProvider = suggestedProvider ?? "self"
            }
          } else if (!includesAcceptedProvider(requirement.accepted_providers, capability.provider)) {
            mismatchReasons.push("provider_not_accepted")
          } else {
            const requiredValue = typeof config.required_value === "string" ? config.required_value : null
            if (requiredValue && capability.value !== requiredValue) {
              mismatchReasons.push("gender_mismatch")
            }
          }
          break
        }
        default:
          if (!satisfiesProofRequirement(user, requirement, gateConfig)) {
            mismatchReasons.push(`unsatisfied:${requirement.proof_type}`)
          }
      }
    }
  }

  return {
    satisfied: missingCapabilities.length === 0 && mismatchReasons.length === 0,
    missingCapabilities,
    mismatchReasons,
    suggestedVerificationProvider: suggestedProvider,
  }
}
