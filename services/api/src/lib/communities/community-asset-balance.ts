import { Contract } from "ethers"
import type { Env } from "../../env"
import type { WalletAttachmentSummary } from "../../types"
import { normalizeEthereumAddress } from "./community-token-gates"
import { resolveAssetBalanceDescriptor } from "./membership/asset-balance-registry"

const ERC20_BALANCE_ABI = ["function balanceOf(address owner) view returns (uint256)"] as const

let balanceReaderForTests: ((assetId: string, walletAddress: string) => Promise<bigint>) | null = null

export function setAssetBalanceReaderForTests(
  reader: ((assetId: string, walletAddress: string) => Promise<bigint>) | null,
): void {
  balanceReaderForTests = reader
}

export type AssetBalanceEvaluation = {
  passed: boolean
  unavailable: boolean
  currentAmountAtomic: string | null
}

export async function evaluateAttachedWalletAssetBalance(input: {
  env: Env
  assetId: string
  minAmountAtomic: string
  walletAttachments: WalletAttachmentSummary[]
}): Promise<AssetBalanceEvaluation> {
  const asset = resolveAssetBalanceDescriptor(input.assetId)
  if (!asset) return { passed: false, unavailable: true, currentAmountAtomic: null }

  const addresses = Array.from(new Set(input.walletAttachments
    .filter((attachment) => attachment.chain_namespace === asset.chainNamespace)
    .map((attachment) => normalizeEthereumAddress(attachment.wallet_address))
    .filter((address): address is string => address != null)))
  const required = BigInt(input.minAmountAtomic)
  let current = 0n
  let unavailable = false

  for (const address of addresses) {
    try {
      const balance = await readBalance(input.env, asset.assetId, asset.contractAddress, address)
      if (balance < 0n) throw new Error("negative asset balance")
      current += balance
      if (current >= required) {
        return { passed: true, unavailable: false, currentAmountAtomic: current.toString() }
      }
    } catch (error) {
      unavailable = true
      console.error("[community-gate] asset balance query failed", {
        asset_id: asset.assetId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return unavailable
    ? { passed: false, unavailable: true, currentAmountAtomic: null }
    : { passed: false, unavailable: false, currentAmountAtomic: current.toString() }
}

async function readBalance(env: Env, assetId: string, contractAddress: string | null, walletAddress: string): Promise<bigint> {
  if (balanceReaderForTests) return balanceReaderForTests(assetId, walletAddress)
  const rpcUrl = String(env.ETHEREUM_RPC_URL ?? "").trim()
  if (!rpcUrl) throw new Error("Ethereum RPC is not configured")
  const { JsonRpcProvider } = await import("ethers")
  const provider = new JsonRpcProvider(rpcUrl, 1, { staticNetwork: true })
  if (!contractAddress) return provider.getBalance(walletAddress)
  const value = await new Contract(contractAddress, ERC20_BALANCE_ABI, provider).balanceOf(walletAddress)
  return BigInt(value)
}
