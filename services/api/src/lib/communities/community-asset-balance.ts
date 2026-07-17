import { Contract } from "ethers"
import type { Env } from "../../env"
import type { WalletAttachmentSummary } from "../../types"
import { getEvmJsonRpcProvider } from "./community-token-gates"
import { listAttachedEvmWalletAddresses } from "./community-token-inventory-gates"
import { resolveAssetBalanceDescriptor } from "./membership/asset-balance-registry"

const ERC20_BALANCE_ABI = ["function balanceOf(address owner) view returns (uint256)"] as const
const ASSET_BALANCE_CACHE_TTL_MS = 15_000
const ASSET_BALANCE_CACHE_MAX_ENTRIES = 2_000

const balanceCache = new Map<string, { amount: bigint; expiresAt: number }>()

let balanceReaderForTests: ((assetId: string, walletAddress: string) => Promise<bigint>) | null = null

export function setAssetBalanceReaderForTests(
  reader: ((assetId: string, walletAddress: string) => Promise<bigint>) | null,
): void {
  balanceReaderForTests = reader
  balanceCache.clear()
}

export function clearAssetBalanceCacheForTests(): void {
  balanceCache.clear()
}

export type AssetBalanceEvaluation = {
  passed: boolean
  unavailable: boolean
  currentAmountAtomic: string | null
  /**
   * How many attached wallets were actually read.
   *
   * A zero current amount is produced both by observing wallets that hold
   * nothing and by having no wallet to observe at all, yet those need opposite
   * remedies. Report the observation so callers never have to infer it.
   */
  evaluatedWalletCount: number
}

export async function evaluateAttachedWalletAssetBalance(input: {
  env: Env
  assetId: string
  minAmountAtomic: string
  walletAttachments: WalletAttachmentSummary[]
}): Promise<AssetBalanceEvaluation> {
  const asset = resolveAssetBalanceDescriptor(input.assetId)
  if (!asset) return { passed: false, unavailable: true, currentAmountAtomic: null, evaluatedWalletCount: 0 }

  const addresses = listAttachedEvmWalletAddresses(input.walletAttachments)
  const required = BigInt(input.minAmountAtomic)
  let current = 0n
  let unavailable = false
  let evaluatedWalletCount = 0

  for (const address of addresses) {
    try {
      const balance = await readBalance(input.env, asset.assetId, asset.chainNamespace, asset.contractAddress, address)
      if (balance < 0n) throw new Error("negative asset balance")
      current += balance
      evaluatedWalletCount += 1
      if (current >= required) {
        return { passed: true, unavailable: false, currentAmountAtomic: current.toString(), evaluatedWalletCount }
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
    ? { passed: false, unavailable: true, currentAmountAtomic: null, evaluatedWalletCount }
    : { passed: false, unavailable: false, currentAmountAtomic: current.toString(), evaluatedWalletCount }
}

async function readBalance(
  env: Env,
  assetId: string,
  chainNamespace: "eip155:1" | "eip155:8453",
  contractAddress: string | null,
  walletAddress: string,
): Promise<bigint> {
  const cacheKey = `${assetId}:${walletAddress.toLowerCase()}`
  const cached = balanceCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return cached.amount
  if (cached) balanceCache.delete(cacheKey)

  const amount = balanceReaderForTests
    ? await balanceReaderForTests(assetId, walletAddress)
    : await readProviderBalance(env, chainNamespace, contractAddress, walletAddress)
  balanceCache.set(cacheKey, { amount, expiresAt: Date.now() + ASSET_BALANCE_CACHE_TTL_MS })
  while (balanceCache.size > ASSET_BALANCE_CACHE_MAX_ENTRIES) {
    const oldestKey = balanceCache.keys().next().value
    if (oldestKey == null) break
    balanceCache.delete(oldestKey)
  }
  return amount
}

async function readProviderBalance(
  env: Env,
  chainNamespace: "eip155:1" | "eip155:8453",
  contractAddress: string | null,
  walletAddress: string,
): Promise<bigint> {
  const provider = getEvmJsonRpcProvider(env, chainNamespace)
  if (!provider) throw new Error("Ethereum RPC is not configured")
  if (!contractAddress) return provider.getBalance(walletAddress)
  const value = await new Contract(contractAddress, ERC20_BALANCE_ABI, provider).balanceOf(walletAddress)
  return BigInt(value)
}
