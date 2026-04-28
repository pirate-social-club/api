import type { MembershipGateSummary } from "../../../types"
import {
  parseGateConfig,
  parseProofRequirements,
  readExcludedCountryValues,
  readMinimumAge,
  readMinimumScore,
  readRequiredCountryValues,
  resolveTokenGateContractAddress,
} from "./gate-config"
import { formatAssetFilterLabel, readInventoryMatchConfig } from "../community-token-inventory-gates"
import type { CommunityGateRuleRow } from "./gate-types"

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

  if (rule.gate_type === "nationality" || rule.gate_type === "gender" || rule.gate_type === "minimum_age" || rule.gate_type === "wallet_score") {
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
    } else if (rule.gate_type === "wallet_score") {
      const minimumScore = readMinimumScore(config, null)
      if (minimumScore != null) {
        summary.minimum_score = minimumScore
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

  if (rule.gate_type === "erc721_inventory_match") {
    const config = readInventoryMatchConfig(gateConfig, rule.chain_namespace)
    if (config) {
      summary.chain_namespace = config.chainNamespace
      summary.contract_address = config.contractAddress
      summary.inventory_provider = config.inventoryProvider
      summary.min_quantity = config.minQuantity
      summary.asset_category = config.assetFilter.category ?? null
      summary.asset_filter_label = formatAssetFilterLabel(config.assetFilter)
    } else if (rule.chain_namespace) {
      summary.chain_namespace = rule.chain_namespace
    }
  }

  return summary
}
