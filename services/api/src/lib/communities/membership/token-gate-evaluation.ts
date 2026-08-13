import type { Env } from "../../../env"
import type { WalletAttachmentSummary } from "../../../types"
import {
  evaluateAttachedEthereumWalletErc721CollectionOwnership,
  hasEvmRpcConfig,
} from "../community-token-gates"
import {
  evaluateErc721InventoryMatch,
  readInventoryMatchConfig,
} from "../community-token-inventory-gates"
import { parseGateConfig, readErc721MinQuantity, resolveTokenGateContractAddress } from "./gate-config"
import type { CommunityGateRuleRow } from "./gate-types"

export async function evaluateTokenGateRule(input: {
  env: Env
  rule: CommunityGateRuleRow
  walletAttachments: WalletAttachmentSummary[]
}): Promise<string[]> {
  return (await evaluateTokenGateRuleDetailed(input)).mismatchReasons
}

export async function evaluateTokenGateRuleDetailed(input: {
  env: Env
  rule: CommunityGateRuleRow
  walletAttachments: WalletAttachmentSummary[]
}): Promise<{ mismatchReasons: string[]; matchedTokenKeys: string[] }> {
  const { env, rule, walletAttachments } = input
  const mismatchReasons: string[] = []
  const gateConfig = parseGateConfig(rule.gate_config_json)

  if (rule.gate_type !== "erc721_holding" && rule.gate_type !== "erc721_inventory_match") {
    return { mismatchReasons: [`unsupported_gate_type:${rule.gate_type}`], matchedTokenKeys: [] }
  }
  if (rule.gate_type === "erc721_inventory_match") {
    const config = readInventoryMatchConfig(gateConfig, rule.chain_namespace)
    if (!config) {
      return { mismatchReasons: ["unsupported_gate_config"], matchedTokenKeys: [] }
    }
    const result = await evaluateErc721InventoryMatch({ env, walletAttachments, config })
    if (result.unavailable) {
      mismatchReasons.push("token_inventory_unavailable")
    } else if (result.matchedQuantity < config.minQuantity) {
      mismatchReasons.push("erc721_inventory_match_required")
    }
    return { mismatchReasons, matchedTokenKeys: result.matchedTokenKeys }
  }
  if (rule.chain_namespace !== "eip155:1" && rule.chain_namespace !== "eip155:8453") {
    return { mismatchReasons: ["unsupported_chain_namespace"], matchedTokenKeys: [] }
  }

  const contractAddress = resolveTokenGateContractAddress(gateConfig)
  if (!contractAddress) {
    return { mismatchReasons: ["unsupported_gate_config"], matchedTokenKeys: [] }
  }
  const minCount = readErc721MinQuantity(gateConfig)
  if (minCount == null) {
    return { mismatchReasons: ["unsupported_gate_config"], matchedTokenKeys: [] }
  }
  if (!hasEvmRpcConfig(env, rule.chain_namespace)) {
    console.error("[community-gate] Ethereum RPC is not configured", {
      gate_type: rule.gate_type,
      chain_namespace: rule.chain_namespace,
    })
    return { mismatchReasons: ["ethereum_rpc_not_configured"], matchedTokenKeys: [] }
  }

  const ownership = await evaluateAttachedEthereumWalletErc721CollectionOwnership({
    chainNamespace: rule.chain_namespace,
    contractAddress,
    env,
    minCount,
    walletAttachments,
  })
  if (ownership.unavailable) {
    mismatchReasons.push("token_inventory_unavailable")
  } else if (!ownership.owns) {
    mismatchReasons.push("erc721_holding_required")
  }
  return { mismatchReasons, matchedTokenKeys: [] }
}
