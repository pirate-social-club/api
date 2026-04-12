import { getAddress, isAddress } from "viem"

import { badRequestError } from "../errors"

type GateRuleInputLike = {
  gate_family?: "identity_proof" | "token_holding"
  gate_type?: string
  proof_requirements?: unknown[] | null
  chain_namespace?: string | null
  gate_config?: Record<string, unknown> | null
}

export const SUPPORTED_IDENTITY_GATE_TYPES = new Set([
  "unique_human",
  "age_over_18",
  "nationality",
  "gender",
  "sanctions_clear",
  "wallet_score",
])

export const SUPPORTED_TOKEN_HOLDING_GATE_TYPES = new Set([
  "erc721_holding",
  "erc1155_holding",
])

type NormalizedGateRule = {
  proofRequirementsJson: string | null
  chainNamespace: string | null
  gateConfigJson: string | null
}

type ProofRequirementInput = {
  proof_type?: unknown
  accepted_providers?: unknown
  accepted_mechanisms?: unknown
  config?: unknown
}

const VALID_ACCEPTED_PROVIDERS_BY_PROOF_TYPE = {
  unique_human: new Set(["self", "very"]),
  age_over_18: new Set(["self"]),
  nationality: new Set(["self"]),
  gender: new Set(["self"]),
  wallet_score: new Set(["passport"]),
  sanctions_clear: new Set(["passport"]),
} as const

const isoCountryCodePattern = /^[A-Z]{2}$/u

function requireRecord(value: Record<string, unknown> | null | undefined, fieldName: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw badRequestError(`${fieldName} must be an object`)
  }

  return value
}

function requireChainNamespace(value: string | null | undefined): string {
  const chainNamespace = String(value || "").trim()
  if (!chainNamespace) {
    throw badRequestError("chain_namespace is required for token_holding gates")
  }

  return chainNamespace
}

function requireAddress(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || !isAddress(value.trim())) {
    throw badRequestError(`${fieldName} must be a valid EVM address`)
  }

  return getAddress(value.trim())
}

function requireIntegerString(
  value: unknown,
  fieldName: string,
  minimum: bigint,
): string {
  const normalized = typeof value === "string"
    ? value.trim()
    : typeof value === "number" || typeof value === "bigint"
      ? String(value)
      : ""

  if (!/^\d+$/.test(normalized)) {
    throw badRequestError(`${fieldName} must be an integer string`)
  }

  const parsed = BigInt(normalized)
  if (parsed < minimum) {
    throw badRequestError(`${fieldName} must be at least ${minimum.toString()}`)
  }

  return parsed.toString()
}

function normalizeAcceptedProviders(value: unknown, proofType: string): string[] | null {
  if (value == null) {
    return null
  }
  if (!Array.isArray(value)) {
    throw badRequestError("accepted_providers must be an array")
  }

  const validProviders = VALID_ACCEPTED_PROVIDERS_BY_PROOF_TYPE[
    proofType as keyof typeof VALID_ACCEPTED_PROVIDERS_BY_PROOF_TYPE
  ]

  const acceptedProviders = value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw badRequestError("accepted_providers entries must be non-empty strings")
    }
    return entry.trim()
  })

  if (!validProviders) {
    return acceptedProviders.length > 0 ? acceptedProviders : null
  }

  const invalidProviders = acceptedProviders.filter((provider) => !validProviders.has(provider))
  if (invalidProviders.length > 0) {
    throw badRequestError(`accepted_providers are invalid for ${proofType}: ${invalidProviders.join(", ")}`)
  }

  return acceptedProviders.length > 0 ? acceptedProviders : null
}

function normalizeAcceptedMechanisms(value: unknown): string[] | null {
  if (value == null) {
    return null
  }
  if (!Array.isArray(value)) {
    throw badRequestError("accepted_mechanisms must be an array")
  }

  const acceptedMechanisms = value.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw badRequestError("accepted_mechanisms entries must be non-empty strings")
    }
    return entry.trim()
  })

  return acceptedMechanisms.length > 0 ? acceptedMechanisms : null
}

function normalizeCountryCode(value: unknown, fieldName: string): string {
  if (typeof value !== "string") {
    throw badRequestError(`${fieldName} must be a 2-letter ISO country code`)
  }

  const normalized = value.trim().toUpperCase()
  if (!isoCountryCodePattern.test(normalized)) {
    throw badRequestError(`${fieldName} must be a 2-letter ISO country code`)
  }

  return normalized
}

function normalizeCountryCodeList(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value)) {
    throw badRequestError(`${fieldName} must be an array of 2-letter ISO country codes`)
  }

  return value.map((entry, index) => normalizeCountryCode(entry, `${fieldName}[${index}]`))
}

function normalizeIdentityGateConfig(gateType: string, gateConfig: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (gateType === "nationality") {
    const config = gateConfig ?? {}
    const hasRequiredValue = config.required_value != null
    const hasExcludedValues = config.excluded_values != null

    if (hasRequiredValue && hasExcludedValues) {
      throw badRequestError("nationality gates must use either required_value or excluded_values, not both")
    }

    if (!hasRequiredValue && !hasExcludedValues) {
      throw badRequestError("nationality gates require required_value or excluded_values")
    }

    if (hasRequiredValue) {
      return {
        required_value: normalizeCountryCode(config.required_value, "gate_config.required_value"),
      }
    }

    const excludedValues = normalizeCountryCodeList(config.excluded_values, "gate_config.excluded_values")
    if (excludedValues.length === 0) {
      throw badRequestError("gate_config.excluded_values must not be empty")
    }

    return {
      excluded_values: excludedValues,
    }
  }

  if (gateType === "gender") {
    if (gateConfig == null) {
      return null
    }

    const requiredValue = gateConfig.required_value
    if (requiredValue == null) {
      return null
    }

    if (requiredValue !== "M" && requiredValue !== "F") {
      throw badRequestError("gate_config.required_value must be M or F")
    }

    return {
      required_value: requiredValue,
    }
  }

  if (gateType === "wallet_score") {
    if (gateConfig == null) {
      return null
    }

    const minimumScore = gateConfig.minimum_score
    if (minimumScore == null) {
      return null
    }

    if (typeof minimumScore !== "number" || !Number.isFinite(minimumScore)) {
      throw badRequestError("gate_config.minimum_score must be a number")
    }

    return {
      minimum_score: minimumScore,
    }
  }

  return gateConfig == null ? null : gateConfig
}

function normalizeIdentityProofRequirements(
  gateType: string,
  value: unknown[] | null | undefined,
): ProofRequirementInput[] {
  if (value == null || value.length === 0) {
    const defaultProviders = VALID_ACCEPTED_PROVIDERS_BY_PROOF_TYPE[
      gateType as keyof typeof VALID_ACCEPTED_PROVIDERS_BY_PROOF_TYPE
    ]
    return [
      {
        proof_type: gateType,
        accepted_providers: defaultProviders ? Array.from(defaultProviders) : null,
      },
    ]
  }

  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw badRequestError("proof_requirements entries must be objects")
    }

    const requirement = entry as ProofRequirementInput
    const proofType = typeof requirement.proof_type === "string" && requirement.proof_type.trim().length > 0
      ? requirement.proof_type.trim()
      : gateType

    return {
      proof_type: proofType,
      accepted_providers: normalizeAcceptedProviders(requirement.accepted_providers, proofType),
      accepted_mechanisms: normalizeAcceptedMechanisms(requirement.accepted_mechanisms),
      config: requirement.config && typeof requirement.config === "object" && !Array.isArray(requirement.config)
        ? requirement.config as Record<string, unknown>
        : requirement.config == null
          ? null
          : (() => {
              throw badRequestError("proof_requirements.config must be an object")
            })(),
    }
  })
}

function normalizeIdentityGate(body: GateRuleInputLike): NormalizedGateRule {
  const gateType = String(body.gate_type)
  if (!SUPPORTED_IDENTITY_GATE_TYPES.has(gateType)) {
    throw badRequestError(`Unsupported identity gate type ${gateType}`)
  }

  return {
    proofRequirementsJson: JSON.stringify(normalizeIdentityProofRequirements(gateType, body.proof_requirements)),
    chainNamespace: null,
    gateConfigJson: (() => {
      const normalizedGateConfig = normalizeIdentityGateConfig(gateType, body.gate_config)
      return normalizedGateConfig == null ? null : JSON.stringify(normalizedGateConfig)
    })(),
  }
}

function normalizeTokenHoldingGate(body: GateRuleInputLike): NormalizedGateRule {
  if (!SUPPORTED_TOKEN_HOLDING_GATE_TYPES.has(String(body.gate_type))) {
    throw badRequestError(`Unsupported token_holding gate type ${String(body.gate_type)}`)
  }

  const gateConfig = requireRecord(body.gate_config, "gate_config")
  const contractAddress = requireAddress(gateConfig.contract_address, "gate_config.contract_address")
  const normalizedChainNamespace = requireChainNamespace(body.chain_namespace)

  if (body.gate_type === "erc721_holding") {
    return {
      proofRequirementsJson: null,
      chainNamespace: normalizedChainNamespace,
      gateConfigJson: JSON.stringify({
        contract_address: contractAddress,
      }),
    }
  }

  return {
    proofRequirementsJson: null,
    chainNamespace: normalizedChainNamespace,
    gateConfigJson: JSON.stringify({
      contract_address: contractAddress,
      token_id: requireIntegerString(gateConfig.token_id, "gate_config.token_id", 0n),
      min_balance: requireIntegerString(gateConfig.min_balance, "gate_config.min_balance", 1n),
    }),
  }
}

export function normalizeGateRuleInput(body: GateRuleInputLike): NormalizedGateRule {
  if (body.gate_family === "identity_proof") {
    return normalizeIdentityGate(body)
  }

  if (body.gate_family === "token_holding") {
    return normalizeTokenHoldingGate(body)
  }

  throw badRequestError(`Unsupported gate family ${String(body.gate_family)}`)
}
