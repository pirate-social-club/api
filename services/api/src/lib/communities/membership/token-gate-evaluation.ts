import type { Env, WalletAttachmentSummary } from "../../../types"
import {
  evaluateAttachedEthereumWalletErc721CollectionOwnership,
  hasEthereumRpcConfig,
  normalizeEthereumAddress,
} from "../community-token-gates"
import {
  evaluateErc721InventoryMatch,
  readInventoryMatchConfig,
} from "../community-token-inventory-gates"
import { parseGateConfig } from "./gate-config"
import type { CommunityGateRuleRow } from "./gate-types"

function resolveTokenGateContractAddress(gateConfig: Record<string, unknown> | null): string | null {
  return normalizeEthereumAddress(gateConfig?.contract_address)
}

export async function evaluateTokenGateRule(input: {
  env: Env
  rule: CommunityGateRuleRow
  walletAttachments: WalletAttachmentSummary[]
  mismatchReasons: string[]
}): Promise<void> {
  const { env, rule, walletAttachments, mismatchReasons } = input
  const gateConfig = parseGateConfig(rule.gate_config_json)
  if (rule.gate_type !== "erc721_holding" && rule.gate_type !== "erc721_inventory_match") {
    mismatchReasons.push(`unsupported_gate_type:${rule.gate_type}`)
    return
  }
  if (rule.gate_type === "erc721_inventory_match") {
    const config = readInventoryMatchConfig(gateConfig, rule.chain_namespace)
    if (!config) {
      mismatchReasons.push("unsupported_gate_config")
      return
    }
    const result = await evaluateErc721InventoryMatch({
      env,
      walletAttachments,
      config,
    })
    if (result.unavailable) {
      mismatchReasons.push("token_inventory_unavailable")
    } else if (result.matchedQuantity < config.minQuantity) {
      mismatchReasons.push("erc721_inventory_match_required")
    }
    return
  }
  if ((rule.chain_namespace ?? null) !== "eip155:1") {
    mismatchReasons.push("unsupported_chain_namespace")
    return
  }

  const contractAddress = resolveTokenGateContractAddress(gateConfig)
  if (!contractAddress) {
    mismatchReasons.push("unsupported_gate_config")
    return
  }

  if (!hasEthereumRpcConfig(env)) {
    mismatchReasons.push("token_inventory_unavailable")
    return
  }

  const ownership = await evaluateAttachedEthereumWalletErc721CollectionOwnership({
    contractAddress,
    env,
    walletAttachments,
  })
  if (ownership.unavailable) {
    mismatchReasons.push("token_inventory_unavailable")
  } else if (!ownership.owns) {
    mismatchReasons.push("erc721_holding_required")
  }
}
