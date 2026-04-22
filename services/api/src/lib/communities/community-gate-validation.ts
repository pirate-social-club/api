import type { CreateCommunityRequest } from "../../types"
import { eligibilityFailed } from "../errors"
import { normalizeIdentityCountryCode, normalizeIdentityCountryCodes } from "../identity/country-codes"
import { normalizeEthereumAddress } from "./community-token-gates"
import {
  getInventoryMatchKeys,
  isAllowedCourtyardRegistry,
  normalizeAssetMatch,
  normalizeInventoryText,
} from "./community-token-inventory-gates"

type PublicV0GateValidationBody = {
  membership_mode?: "open" | "request" | "gated" | null
  default_age_gate_policy?: "none" | "18_plus" | null
  anonymous_identity_scope?: "community_stable" | "thread_stable" | "post_ephemeral" | null
  gate_rules?: CreateCommunityRequest["gate_rules"]
}

type GateRuleInput = NonNullable<CreateCommunityRequest["gate_rules"]>[number]
type GateProofRequirementInput = NonNullable<GateRuleInput["proof_requirements"]>[number]
type GateAcceptedProvider = NonNullable<GateProofRequirementInput["accepted_providers"]>[number]

const VALID_PUBLIC_V0_PROVIDERS_BY_PROOF_TYPE = {
  unique_human: new Set(["self", "very"]),
  age_over_18: new Set(["self"]),
  minimum_age: new Set(["self"]),
  nationality: new Set(["self"]),
  gender: new Set(["self"]),
  wallet_score: new Set(["passport"]),
  sanctions_clear: new Set(["self", "passport"]),
} as const

const SELF_OFAC_MECHANISM = "self_ofac"
const PASSPORT_CLEAN_HANDS_MECHANISM = "passport_clean_hands"
const PASSPORT_CLEAN_HANDS_LEGACY_MECHANISM = "CleanHands"

export function assertPublicV0GateConfiguration(
  body: PublicV0GateValidationBody,
  input: {
    ageOver18Verified: boolean
  },
): void {
  body.gate_rules = normalizePublicV0GateRules(body.gate_rules ?? [])
  assertPublicV0MembershipBasics(body, input)

  const gateRules = body.gate_rules ?? []
  assertPublicV0TokenGateConfiguration(gateRules)
  assertPublicV0AcceptedProviders(gateRules)
  assertPublicV0IdentityGateConfiguration(gateRules)
}

export function normalizePublicV0GateRules(gateRules: GateRuleInput[]): GateRuleInput[] {
  const normalized = gateRules.map((rule) => ({ ...rule }))
  if (!hasSelfBackedIdentityGate(normalized)) {
    return normalized
  }

  const sanctionsIndex = normalized.findIndex((rule) => rule.gate_type === "sanctions_clear")
  if (sanctionsIndex >= 0) {
    const existing = normalized[sanctionsIndex]
    const requirement = existing.proof_requirements?.[0] ?? { proof_type: "sanctions_clear" as const }
    normalized[sanctionsIndex] = {
      ...existing,
      gate_family: "identity_proof",
      gate_type: "sanctions_clear",
      proof_requirements: [{
        ...requirement,
        proof_type: "sanctions_clear",
        accepted_providers: mergeAcceptedProviders(requirement.accepted_providers, ["self"]),
        accepted_mechanisms: mergeStrings(requirement.accepted_mechanisms, [SELF_OFAC_MECHANISM]),
      }],
    }
    return normalized
  }

  normalized.push({
    scope: "membership",
    gate_family: "identity_proof",
    gate_type: "sanctions_clear",
    proof_requirements: [{
      proof_type: "sanctions_clear",
      accepted_providers: ["self"],
      accepted_mechanisms: [SELF_OFAC_MECHANISM],
    }],
  })
  return normalized
}

function mergeAcceptedProviders(
  current: GateProofRequirementInput["accepted_providers"],
  additions: GateAcceptedProvider[],
): GateAcceptedProvider[] {
  return Array.from(new Set([...(current ?? []), ...additions]))
}

function mergeStrings(current: string[] | null | undefined, additions: string[]): string[] {
  return Array.from(new Set([...(current ?? []), ...additions]))
}

function hasSelfBackedIdentityGate(gateRules: GateRuleInput[]): boolean {
  return gateRules.some((rule) => {
    if (rule.gate_family !== "identity_proof" || rule.gate_type === "sanctions_clear") {
      return false
    }
    return (rule.proof_requirements ?? []).some((requirement) =>
      requirement.accepted_providers?.includes("self")
      || (
        requirement.accepted_providers == null
        && ["unique_human", "age_over_18", "minimum_age", "nationality", "gender"].includes(requirement.proof_type)
      )
    )
  })
}

function assertPublicV0MembershipBasics(
  body: PublicV0GateValidationBody,
  input: {
    ageOver18Verified: boolean
  },
): void {
  if (!["open", "request", "gated"].includes(body.membership_mode ?? "open")) {
    throw eligibilityFailed("Public v0 community creation only allows open, request, or gated membership")
  }
  if ((body.anonymous_identity_scope ?? null) === "post_ephemeral") {
    throw eligibilityFailed("post_ephemeral anonymous scope is not allowed in public v0 community creation")
  }
  if ((body.default_age_gate_policy ?? "none") === "18_plus" && !input.ageOver18Verified) {
    throw eligibilityFailed("age_over_18 verification is required for 18_plus communities")
  }
  if (body.gate_rules?.some((rule) => rule.scope === "viewer" || rule.scope === "posting")) {
    throw eligibilityFailed("Public v0 community creation only allows membership-scope gates")
  }
}

function assertPublicV0TokenGateConfiguration(gateRules: GateRuleInput[]): void {
  for (const rule of gateRules) {
    if ((rule.gate_family as string) !== "token_holding") {
      continue
    }

    if (rule.gate_type !== "erc721_holding" && rule.gate_type !== "erc721_inventory_match") {
      throw eligibilityFailed("Public v0 community creation only supports ERC-721 token gates")
    }
    if ((rule.proof_requirements?.length ?? 0) > 0) {
      throw eligibilityFailed("ERC-721 community gates do not accept proof_requirements")
    }

    const config = (rule.gate_config ?? {}) as Record<string, unknown>
    if (rule.gate_type === "erc721_holding") {
      if ((rule.chain_namespace ?? null) !== "eip155:1") {
        throw eligibilityFailed("ERC-721 community gates must target Ethereum mainnet (eip155:1)")
      }
      if (!normalizeEthereumAddress(config.contract_address)) {
        throw eligibilityFailed("ERC-721 community gates require a valid Ethereum contract_address")
      }
      continue
    }

    assertErc721InventoryMatchGate(rule, config)
  }
}

function assertErc721InventoryMatchGate(rule: GateRuleInput, config: Record<string, unknown>): void {
  if ((rule.chain_namespace ?? null) !== "eip155:1" && (rule.chain_namespace ?? null) !== "eip155:137") {
    throw eligibilityFailed("Courtyard inventory gates must target an allowlisted Courtyard chain")
  }
  if (!normalizeEthereumAddress(config.contract_address)) {
    throw eligibilityFailed("Courtyard inventory gates require a valid contract_address")
  }
  if (!isAllowedCourtyardRegistry({ chainNamespace: rule.chain_namespace, contractAddress: config.contract_address })) {
    throw eligibilityFailed("Courtyard inventory gates require an allowlisted Courtyard contract")
  }
  if (config.inventory_provider !== "courtyard") {
    throw eligibilityFailed("ERC-721 inventory gates require inventory_provider courtyard")
  }
  if (!Number.isInteger(config.min_quantity) || (config.min_quantity as number) < 1 || (config.min_quantity as number) > 100) {
    throw eligibilityFailed("ERC-721 inventory gates require min_quantity from 1 to 100")
  }
  const rawMatch = config.match ?? config.asset_filter
  if (!rawMatch || typeof rawMatch !== "object" || Array.isArray(rawMatch)) {
    throw eligibilityFailed("ERC-721 inventory gates require match")
  }
  const filter = rawMatch as Record<string, unknown>
  const allowedKeys = new Set(getInventoryMatchKeys())
  const invalidKeys = Object.keys(filter).filter((key) => !allowedKeys.has(key))
  if (invalidKeys.length > 0) {
    throw eligibilityFailed(`ERC-721 inventory match has unsupported keys: ${invalidKeys.join(", ")}`)
  }
  if (!normalizeAssetMatch(rawMatch)) {
    throw eligibilityFailed("ERC-721 inventory match must include category plus a supported matching field")
  }
  if (Object.values(filter).some((value) => typeof value === "string" && normalizeInventoryText(value) == null)) {
    throw eligibilityFailed("ERC-721 inventory match values must be non-empty strings")
  }
}

function assertPublicV0AcceptedProviders(gateRules: GateRuleInput[]): void {
  for (const rule of gateRules) {
    for (const requirement of rule.proof_requirements ?? []) {
      const acceptedProviders = requirement.accepted_providers ?? []
      if (acceptedProviders.length === 0) {
        continue
      }

      const validProviders = VALID_PUBLIC_V0_PROVIDERS_BY_PROOF_TYPE[
        requirement.proof_type as keyof typeof VALID_PUBLIC_V0_PROVIDERS_BY_PROOF_TYPE
      ]
      if (!validProviders) {
        continue
      }

      const providerSet = validProviders as ReadonlySet<string>
      const invalidProviders = acceptedProviders.filter((provider) => !providerSet.has(provider))
      if (invalidProviders.length > 0) {
        throw eligibilityFailed(
          `Invalid accepted_providers for ${requirement.proof_type}: ${invalidProviders.join(", ")}`,
        )
      }
    }
  }
}

function assertPublicV0IdentityGateConfiguration(gateRules: GateRuleInput[]): void {
  let nationalityGateCount = 0
  let genderGateCount = 0
  let minimumAgeGateCount = 0
  let walletScoreGateCount = 0
  let sanctionsClearGateCount = 0

  for (const rule of gateRules) {
    if (rule.gate_type === "sanctions_clear") {
      sanctionsClearGateCount += 1
      assertSingleIdentityGateCount(sanctionsClearGateCount, "sanctions_clear")
      assertSanctionsClearGate(rule)
      continue
    }
    if (rule.gate_type === "wallet_score") {
      walletScoreGateCount += 1
      assertSingleIdentityGateCount(walletScoreGateCount, "wallet_score")
      assertWalletScoreGate(rule)
      continue
    }
    if (rule.gate_type === "minimum_age") {
      minimumAgeGateCount += 1
      assertSingleIdentityGateCount(minimumAgeGateCount, "minimum_age")
      assertMinimumAgeGate(rule)
      continue
    }
    if (rule.gate_type === "gender") {
      genderGateCount += 1
      assertSingleIdentityGateCount(genderGateCount, "gender")
      assertGenderGate(rule)
      continue
    }
    if (rule.gate_type === "nationality") {
      nationalityGateCount += 1
      assertSingleIdentityGateCount(nationalityGateCount, "nationality")
      assertNationalityGate(rule)
    }
  }
}

function assertSingleIdentityGateCount(
  count: number,
  gateType: "minimum_age" | "gender" | "nationality" | "wallet_score" | "sanctions_clear",
): void {
  if (count <= 1) {
    return
  }

  const gateName = gateType === "minimum_age" ? "minimum_age" : gateType
  throw eligibilityFailed(`Public v0 communities support at most one ${gateName} gate`)
}

function assertSanctionsClearGate(rule: GateRuleInput): void {
  const requirements = rule.proof_requirements ?? []
  if (requirements.length !== 1 || requirements[0].proof_type !== "sanctions_clear") {
    throw eligibilityFailed("Sanctions clear gate must have exactly one sanctions_clear proof requirement")
  }

  const acceptedProviders = requirements[0].accepted_providers ?? []
  const uniqueProviders = Array.from(new Set(acceptedProviders))
  if (uniqueProviders.length === 0 || uniqueProviders.some((provider) => provider !== "self" && provider !== "passport")) {
    throw eligibilityFailed("Sanctions clear gate accepted_providers must include self or passport")
  }

  const acceptedMechanisms = requirements[0].accepted_mechanisms ?? []
  const uniqueMechanisms = Array.from(new Set(acceptedMechanisms))
  const providerSupportsMechanism = (mechanism: string): boolean => {
    if (mechanism === SELF_OFAC_MECHANISM) return uniqueProviders.includes("self")
    if (mechanism === PASSPORT_CLEAN_HANDS_MECHANISM || mechanism === PASSPORT_CLEAN_HANDS_LEGACY_MECHANISM) {
      return uniqueProviders.includes("passport")
    }
    return false
  }
  const invalidMechanisms = uniqueMechanisms.filter((mechanism) => !providerSupportsMechanism(mechanism))
  if (invalidMechanisms.length > 0) {
    throw eligibilityFailed(`Invalid accepted_mechanisms for sanctions_clear: ${invalidMechanisms.join(", ")}`)
  }
  if (uniqueProviders.includes("self") && !uniqueMechanisms.includes(SELF_OFAC_MECHANISM)) {
    throw eligibilityFailed("Self sanctions clear gate must accept self_ofac")
  }
  if (
    uniqueProviders.includes("passport")
    && uniqueMechanisms.length > 0
    && !uniqueMechanisms.some((mechanism) => mechanism === PASSPORT_CLEAN_HANDS_MECHANISM || mechanism === PASSPORT_CLEAN_HANDS_LEGACY_MECHANISM)
  ) {
    throw eligibilityFailed("Passport sanctions clear gate must accept passport_clean_hands")
  }
}

function assertWalletScoreGate(rule: GateRuleInput): void {
  const requirements = rule.proof_requirements ?? []
  if (requirements.length !== 1 || requirements[0].proof_type !== "wallet_score") {
    throw eligibilityFailed("Wallet score gate must have exactly one wallet_score proof requirement")
  }

  const requirement = requirements[0]
  const acceptedProviders = requirement.accepted_providers ?? []
  if (acceptedProviders.length !== 1 || acceptedProviders[0] !== "passport") {
    throw eligibilityFailed("Wallet score gate accepted_providers must be exactly [\"passport\"]")
  }

  const config = (requirement.config ?? rule.gate_config ?? {}) as Record<string, unknown>
  const minimumScore = typeof config.minimum_score === "number" ? config.minimum_score : null
  if (minimumScore == null || !Number.isFinite(minimumScore) || minimumScore < 0 || minimumScore > 100) {
    throw eligibilityFailed("Wallet score gate minimum_score must be a number from 0 to 100")
  }
}

function assertMinimumAgeGate(rule: GateRuleInput): void {
  const requirements = rule.proof_requirements ?? []
  if (requirements.length !== 1 || requirements[0].proof_type !== "minimum_age") {
    throw eligibilityFailed("Minimum age gate must have exactly one minimum_age proof requirement")
  }

  const requirement = requirements[0]
  const acceptedProviders = requirement.accepted_providers ?? []
  if (acceptedProviders.length !== 1 || acceptedProviders[0] !== "self") {
    throw eligibilityFailed("Minimum age gate accepted_providers must be exactly [\"self\"]")
  }

  const config = (requirement.config ?? rule.gate_config ?? {}) as Record<string, unknown>
  const minimumAge = typeof config.minimum_age === "number" ? config.minimum_age : null
  if (minimumAge == null || !Number.isInteger(minimumAge) || minimumAge < 18 || minimumAge > 125) {
    throw eligibilityFailed("Minimum age gate minimum_age must be an integer from 18 to 125")
  }
}

function assertGenderGate(rule: GateRuleInput): void {
  const requirements = rule.proof_requirements ?? []
  if (requirements.length !== 1 || requirements[0].proof_type !== "gender") {
    throw eligibilityFailed("Gender gate must have exactly one gender proof requirement")
  }

  const requirement = requirements[0]
  const acceptedProviders = requirement.accepted_providers ?? []
  if (acceptedProviders.length !== 1 || acceptedProviders[0] !== "self") {
    throw eligibilityFailed("Gender gate accepted_providers must be exactly [\"self\"]")
  }

  const config = (requirement.config ?? rule.gate_config ?? {}) as Record<string, unknown>
  const requiredValue = typeof config.required_value === "string" ? config.required_value : null
  if (!requiredValue) {
    throw eligibilityFailed("Gender gate requires a required_value in config")
  }
  if (requiredValue !== "M" && requiredValue !== "F") {
    throw eligibilityFailed("Gender gate required_value must be either \"M\" or \"F\"")
  }
}

function assertNationalityGate(rule: GateRuleInput): void {
  const requirements = rule.proof_requirements ?? []
  if (requirements.length !== 1 || requirements[0].proof_type !== "nationality") {
    throw eligibilityFailed("Nationality gate must have exactly one nationality proof requirement")
  }

  const requirement = requirements[0]
  const acceptedProviders = requirement.accepted_providers ?? []
  if (acceptedProviders.length !== 1 || acceptedProviders[0] !== "self") {
    throw eligibilityFailed("Nationality gate accepted_providers must be exactly [\"self\"]")
  }

  const config = (requirement.config ?? rule.gate_config ?? {}) as Record<string, unknown>
  const legacyRequiredValue = normalizeIdentityCountryCode(config.required_value)
  const requiredValues = new Set<string>()
  if (legacyRequiredValue) {
    requiredValues.add(legacyRequiredValue)
  }
  for (const value of normalizeIdentityCountryCodes(config.required_values)) {
    requiredValues.add(value)
  }
  if (requiredValues.size === 0) {
    throw eligibilityFailed("Nationality gate requires required_value or required_values in config")
  }

  const rawRequiredValues = Array.isArray(config.required_values) ? config.required_values : []
  if (
    (config.required_value != null && !legacyRequiredValue)
    || rawRequiredValues.some((value) => normalizeIdentityCountryCode(value) == null)
  ) {
    throw eligibilityFailed("Nationality gate country codes must be valid ISO-2 or ISO-3 codes")
  }
}
