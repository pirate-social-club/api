import { eligibilityFailed } from "../../errors"
import type { Env } from "../../../env"
import { evaluateErc721ContractSupport, type EvmChainNamespace } from "../community-token-gates"
import { isAssetBalanceEvaluable, resolveAssetBalanceDescriptor } from "./asset-balance-registry"
import { flattenGatePolicyAtoms } from "./gate-summary"
import type { GatePolicy } from "./gate-types"

export async function assertGatePolicyContractsValid(input: {
  env: Env
  policy: GatePolicy | null | undefined
}): Promise<void> {
  assertAssetBalanceAssetsEvaluable(input)

  const contractMap = new Map<string, { chainNamespace: EvmChainNamespace; contractAddress: string }>()
  for (const atom of flattenGatePolicyAtoms(input.policy ?? null)) {
    if (atom.type !== "erc721_holding" && atom.type !== "erc721_inventory_match") continue
    // Polygon inventory is evaluated by Courtyard and has no configured RPC
    // transport here. Its address shape is enforced by policy validation; do
    // the live ERC-165 check wherever this service has a chain transport.
    if (atom.chain_namespace !== "eip155:1" && atom.chain_namespace !== "eip155:8453") continue
    contractMap.set(`${atom.chain_namespace}:${atom.contract_address.toLowerCase()}`, {
      chainNamespace: atom.chain_namespace,
      contractAddress: atom.contract_address,
    })
  }
  const erc721Contracts = [...contractMap.values()]

  for (const { chainNamespace, contractAddress } of erc721Contracts) {
    const result = await evaluateErc721ContractSupport({
      chainNamespace,
      contractAddress,
      env: input.env,
    })
    if (result.unavailable) {
      throw eligibilityFailed("erc721_holding contract validation is temporarily unavailable. Check RPC availability and try again.")
    }
    if (!result.supported) {
      throw eligibilityFailed("erc721_holding gate contract must support ERC-721")
    }
  }
}

/**
 * Refuse an asset_balance gate this deployment could never evaluate.
 *
 * The trusted registry already fixes the contract and standard, so authoring
 * needs no live request here: registry membership plus a configured chain
 * transport is sufficient, and checking configuration only keeps transient
 * provider downtime from becoming an authoring outage.
 *
 * Without this check the failure is silent and permanent rather than loud:
 * the policy saves, then every evaluation reports provider_unavailable and the
 * community is unjoinable for everyone. Unlike an RPC outage this is not
 * retryable, so the message must not invite a retry.
 */
function assertAssetBalanceAssetsEvaluable(input: { env: Env; policy: GatePolicy | null | undefined }): void {
  for (const atom of flattenGatePolicyAtoms(input.policy ?? null)) {
    if (atom.type !== "asset_balance") {
      continue
    }
    const asset = resolveAssetBalanceDescriptor(atom.asset_id)
    if (!asset) {
      throw eligibilityFailed("asset_balance gate requires a supported canonical asset_id")
    }
    if (!isAssetBalanceEvaluable(input.env, asset)) {
      throw eligibilityFailed(
        `asset_balance gate for ${asset.label} cannot be evaluated here. Choose an asset from the supported asset catalog.`,
      )
    }
  }
}
