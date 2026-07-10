import type { Env } from "../../../env"
import type { WalletAttachmentSummary } from "../../../types"
import {
  evaluateAttachedEthereumWalletErc721CollectionOwnership,
  hasEthereumRpcConfig,
} from "../community-token-gates"
import {
  evaluateErc721InventoryMatch,
  readInventoryMatchConfig,
} from "../community-token-inventory-gates"
import { parseGateConfig, resolveTokenGateContractAddress } from "./gate-config"
import type { CommunityGateRuleRow } from "./gate-types"

export async function evaluateTokenGateRule(input: {
  env: Env
  rule: CommunityGateRuleRow
  walletAttachments: WalletAttachmentSummary[]
}): Promise<string[]> {
  const { env, rule, walletAttachments } = input
  const mismatchReasons: string[] = []
  const gateConfig = parseGateConfig(rule.gate_config_json)

  if (rule.gate_type !== "erc721_holding" && rule.gate_type !== "erc721_inventory_match") {
    return [`unsupported_gate_type:${rule.gate_type}`]
  }
  if (rule.gate_type === "erc721_inventory_match") {
    const config = readInventoryMatchConfig(gateConfig, rule.chain_namespace)
    if (!config) {
      return ["unsupported_gate_config"]
    }
    const result = await evaluateErc721InventoryMatch({ env, walletAttachments, config })
    if (result.unavailable) {
      mismatchReasons.push("token_inventory_unavailable")
    } else if (result.matchedQuantity < config.minQuantity) {
      mismatchReasons.push("erc721_inventory_match_required")
    }
    return mismatchReasons
  }
  if ((rule.chain_namespace ?? null) !== "eip155:1") {
    return ["unsupported_chain_namespace"]
  }

  const contractAddress = resolveTokenGateContractAddress(gateConfig)
  if (!contractAddress) {
    return ["unsupported_gate_config"]
  }
  const minCount = readErc721MinCount(gateConfig)
  if (minCount == null) {
    return ["unsupported_gate_config"]
  }
  if (!hasEthereumRpcConfig(env)) {
    console.error("[community-gate] Ethereum RPC is not configured", {
      gate_type: rule.gate_type,
      chain_namespace: rule.chain_namespace,
    })
    return ["ethereum_rpc_not_configured"]
  }

  const ownership = await evaluateAttachedEthereumWalletErc721CollectionOwnership({
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
  return mismatchReasons
}

function readErc721MinCount(gateConfig: Record<string, unknown> | null): number | null {
  const raw = gateConfig?.min_count
  if (raw == null) {
    return 1
  }
  return Number.isInteger(raw) && (raw as number) >= 1 && (raw as number) <= 100 ? raw as number : null
}
