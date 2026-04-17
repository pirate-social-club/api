import { JsonRpcProvider, getAddress } from "ethers"
import { globalSingleton } from "../db-helpers"
import type { Env } from "../../types"

let ensResolverForTests: ((env: Env, walletAddress: string) => Promise<string | null>) | null = null

export function setEnsResolverForTests(
  resolver: ((env: Env, walletAddress: string) => Promise<string | null>) | null,
): void {
  ensResolverForTests = resolver
}

function getEthereumRpcUrl(env: Env): string | null {
  const value = String(env.ETHEREUM_RPC_URL || "").trim()
  return value.length > 0 ? value : null
}

function getEthereumProvider(env: Env): JsonRpcProvider | null {
  const rpcUrl = getEthereumRpcUrl(env)
  if (!rpcUrl) {
    return null
  }

  return globalSingleton("ethereumRpcProvider", rpcUrl, () => (
    new JsonRpcProvider(rpcUrl, 1, { staticNetwork: true })
  ))
}

export async function resolveVerifiedEnsName(env: Env, walletAddress: string): Promise<string | null> {
  if (ensResolverForTests) {
    return await ensResolverForTests(env, walletAddress)
  }

  const provider = getEthereumProvider(env)
  if (!provider) {
    return null
  }

  let normalizedWalletAddress: string
  try {
    normalizedWalletAddress = getAddress(walletAddress)
  } catch {
    return null
  }

  try {
    const reverseName = await provider.lookupAddress(normalizedWalletAddress)
    if (!reverseName) {
      return null
    }

    const resolvedAddress = await provider.resolveName(reverseName)
    if (!resolvedAddress) {
      return null
    }

    return getAddress(resolvedAddress) === normalizedWalletAddress
      ? reverseName.trim().toLowerCase()
      : null
  } catch {
    return null
  }
}
