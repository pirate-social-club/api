import type { MembershipGateExpressionSummary, MembershipGateSummary } from "../../../types"
import {
  parseGateConfig,
  parseProofRequirements,
  readExcludedCountryValues,
  readErc721MinQuantity,
  readMinimumAge,
  readMinimumScore,
  readRequiredCountryValues,
  resolveTokenGateContractAddress,
} from "./gate-config"
import { formatAssetFilterLabel, readInventoryMatchConfig } from "../community-token-inventory-gates"
import { resolveAssetBalanceDescriptor } from "./asset-balance-registry"
import type { CommunityGateRuleRow, GateAtom, GateExpression, GatePolicy } from "./gate-types"

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
    const minQuantity = readErc721MinQuantity(gateConfig)
    if (minQuantity != null) {
      summary.min_quantity = minQuantity
    }
  }

  if (rule.gate_type === "erc721_inventory_match") {
    const config = readInventoryMatchConfig(gateConfig, rule.chain_namespace)
    if (config) {
      summary.chain_namespace = config.chainNamespace
      summary.contract_address = config.contractAddress
      summary.inventory_provider = config.inventoryProvider
      summary.min_quantity = config.minQuantity
      summary.asset_category = Array.isArray(config.assetFilter.category)
        ? config.assetFilter.category[0] ?? null
        : config.assetFilter.category ?? null
      summary.asset_filter_label = formatAssetFilterLabel(config.assetFilter)
    } else if (rule.chain_namespace) {
      summary.chain_namespace = rule.chain_namespace
    }
  }

  return summary
}

export function flattenGatePolicyAtoms(policy: GatePolicy | null): GateAtom[] {
  if (!policy) {
    return []
  }
  const atoms: GateAtom[] = []
  collectAtoms(policy.expression, atoms)
  return atoms
}

function collectAtoms(expression: GateExpression, atoms: GateAtom[]): void {
  if (expression.op === "gate") {
    atoms.push(expression.gate)
    return
  }
  for (const child of expression.children) {
    collectAtoms(child, atoms)
  }
}

export function buildMembershipGateSummariesFromPolicy(policy: GatePolicy | null): MembershipGateSummary[] {
  return flattenGatePolicyAtoms(policy).map(buildMembershipGateSummaryFromAtom)
}

export function buildMembershipGateExpressionFromPolicy(
  policy: GatePolicy | null,
): MembershipGateExpressionSummary | null {
  return policy ? buildMembershipGateExpression(policy.expression) : null
}

function buildMembershipGateExpression(expression: GateExpression): MembershipGateExpressionSummary {
  if (expression.op === "gate") {
    return { op: "gate", gate: buildMembershipGateSummaryFromAtom(expression.gate) }
  }
  return {
    op: expression.op,
    children: expression.children.map(buildMembershipGateExpression),
  }
}

export function getGatePolicyMatchMode(policy: GatePolicy | null): "all" | "any" {
  return policy?.expression.op === "or" ? "any" : "all"
}

function buildMembershipGateSummaryFromAtom(atom: GateAtom): MembershipGateSummary {
  const summary: MembershipGateSummary = {
    gate_type: atom.type as MembershipGateSummary["gate_type"],
  }

  if ("accepted_providers" in atom && atom.accepted_providers?.length) {
    summary.accepted_providers = atom.accepted_providers as MembershipGateSummary["accepted_providers"]
  } else if ("provider" in atom && (atom.provider === "self" || atom.provider === "very" || atom.provider === "passport")) {
    summary.accepted_providers = [atom.provider] as MembershipGateSummary["accepted_providers"]
  }

  switch (atom.type) {
    case "altcha_pow":
      break
    case "minimum_age":
      summary.required_minimum_age = atom.minimum_age
      break
    case "nationality":
      if (atom.allowed.length === 1) {
        summary.required_value = atom.allowed[0]
      } else {
        summary.required_values = atom.allowed
      }
      break
    case "gender":
      if (atom.allowed.length === 1) {
        summary.required_value = atom.allowed[0]
      } else {
        summary.required_values = atom.allowed
      }
      break
    case "wallet_score":
      summary.minimum_score = atom.minimum_score
      break
    case "erc721_holding":
      summary.chain_namespace = atom.chain_namespace
      summary.contract_address = atom.contract_address
      summary.min_quantity = atom.min_count ?? 1
      break
    case "erc721_inventory_match":
      summary.chain_namespace = atom.chain_namespace
      summary.contract_address = atom.contract_address
      summary.inventory_provider = atom.provider
      summary.min_quantity = atom.min_quantity
      summary.asset_category = Array.isArray(atom.match.category)
        ? atom.match.category[0] ?? null
        : typeof atom.match.category === "string" ? atom.match.category : null
      summary.asset_filter_label = formatAssetFilterLabel(atom.match)
      break
    case "asset_balance": {
      summary.asset_id = atom.asset_id
      summary.min_amount_atomic = atom.min_amount_atomic
      // Record display metadata on the summary itself: members are shown this
      // gate by a synchronous formatter that cannot reach the authenticated
      // capability catalog, and the label must stay truthful even if the asset
      // later leaves that catalog.
      const asset = resolveAssetBalanceDescriptor(atom.asset_id)
      if (asset) {
        summary.asset_symbol = asset.symbol
        summary.asset_decimals = asset.decimals
      }
      break
    }
    case "unique_human":
      break
  }

  return summary
}
