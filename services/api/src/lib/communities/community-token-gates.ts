import { Contract, FetchRequest, JsonRpcProvider, getAddress } from "ethers"
import { globalSingleton } from "../db-helpers"
import type { Env } from "../../env"
import type { WalletAttachmentSummary } from "../../types"

const ERC721_COLLECTION_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
] as const
const ERC721_INTERFACE_ID = "0x80ac58cd"
const ETHEREUM_RPC_TIMEOUT_MS = 8_000

let erc721OwnershipCheckerForTests: ((input: {
  contractAddress: string
  env: Env
  walletAddress: string
}) => Promise<boolean | number>) | null = null
let erc721ContractSupportCheckerForTests: ((input: {
  contractAddress: string
  env: Env
}) => Promise<boolean>) | null = null

export function setErc721OwnershipCheckerForTests(
  checker: ((input: { contractAddress: string; env: Env; walletAddress: string }) => Promise<boolean | number>) | null,
): void {
  erc721OwnershipCheckerForTests = checker
}

export function setErc721ContractSupportCheckerForTests(
  checker: ((input: { contractAddress: string; env: Env }) => Promise<boolean>) | null,
): void {
  erc721ContractSupportCheckerForTests = checker
}

export function hasEthereumRpcConfig(env: Env): boolean {
  return String(env.ETHEREUM_RPC_URL || "").trim().length > 0
}

export function getEthereumProvider(env: Env): JsonRpcProvider | null {
  return getEvmJsonRpcProvider(env, "eip155:1")
}

export function getEvmJsonRpcProvider(env: Env, chainNamespace: "eip155:1" | "eip155:8453"): JsonRpcProvider | null {
  const rpcUrl = String(chainNamespace === "eip155:1" ? env.ETHEREUM_RPC_URL : env.BASE_MAINNET_RPC_URL || "").trim()
  if (!rpcUrl) {
    return null
  }

  const chainId = chainNamespace === "eip155:1" ? 1 : 8453
  return globalSingleton(`evmRpcProvider:${chainNamespace}`, rpcUrl, () => {
    const request = new FetchRequest(rpcUrl)
    request.timeout = ETHEREUM_RPC_TIMEOUT_MS
    return new JsonRpcProvider(request, chainId, { staticNetwork: true })
  })
}

export function normalizeEthereumAddress(value: unknown): string | null {
  if (typeof value !== "string") {
    return null
  }

  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }

  try {
    return getAddress(trimmed)
  } catch {
    return null
  }
}

function listEthereumMainnetWalletAddresses(walletAttachments: WalletAttachmentSummary[]): string[] {
  const seen = new Set<string>()
  const addresses: string[] = []

  for (const attachment of walletAttachments) {
    if (attachment.chain_namespace !== "eip155:1") {
      continue
    }

    const normalized = normalizeEthereumAddress(attachment.wallet_address)
    if (!normalized || seen.has(normalized)) {
      continue
    }

    seen.add(normalized)
    addresses.push(normalized)
  }

  return addresses
}

export async function evaluateAttachedEthereumWalletErc721CollectionOwnership(input: {
  contractAddress: string
  env: Env
  minCount?: number
  walletAttachments: WalletAttachmentSummary[]
}): Promise<{ owns: boolean; unavailable: boolean }> {
  const normalizedContractAddress = normalizeEthereumAddress(input.contractAddress)
  if (!normalizedContractAddress) {
    return { owns: false, unavailable: false }
  }

  const walletAddresses = listEthereumMainnetWalletAddresses(input.walletAttachments)
  if (walletAddresses.length === 0) {
    return { owns: false, unavailable: false }
  }
  const minCount = Number.isInteger(input.minCount) && input.minCount != null && input.minCount > 1 ? input.minCount : 1

  if (erc721OwnershipCheckerForTests) {
    let totalBalance = 0
    for (const walletAddress of walletAddresses) {
      const result = await erc721OwnershipCheckerForTests({
        contractAddress: normalizedContractAddress,
        env: input.env,
        walletAddress,
      })
      totalBalance += typeof result === "number" ? Math.max(0, result) : result ? 1 : 0
      if (totalBalance >= minCount) {
        return { owns: true, unavailable: false }
      }
    }
    return { owns: false, unavailable: false }
  }

  const provider = getEthereumProvider(input.env)
  if (!provider) {
    return { owns: false, unavailable: true }
  }

  const contract = new Contract(normalizedContractAddress, ERC721_COLLECTION_ABI, provider)
  let unavailable = false
  let totalBalance = 0n
  for (const walletAddress of walletAddresses) {
    try {
      const balance = await contract.balanceOf(walletAddress) as bigint
      totalBalance += balance
      if (totalBalance >= BigInt(minCount)) {
        return { owns: true, unavailable: false }
      }
    } catch {
      unavailable = true
    }
  }

  return { owns: false, unavailable }
}

export async function evaluateErc721ContractSupport(input: {
  contractAddress: string
  env: Env
}): Promise<{ supported: boolean; unavailable: boolean }> {
  const normalizedContractAddress = normalizeEthereumAddress(input.contractAddress)
  if (!normalizedContractAddress) {
    return { supported: false, unavailable: false }
  }

  if (erc721ContractSupportCheckerForTests) {
    return {
      supported: await erc721ContractSupportCheckerForTests({
        contractAddress: normalizedContractAddress,
        env: input.env,
      }),
      unavailable: false,
    }
  }

  const provider = getEthereumProvider(input.env)
  if (!provider) {
    return { supported: false, unavailable: true }
  }

  try {
    const contract = new Contract(normalizedContractAddress, ERC721_COLLECTION_ABI, provider)
    return {
      supported: Boolean(await contract.supportsInterface(ERC721_INTERFACE_ID)),
      unavailable: false,
    }
  } catch {
    return { supported: false, unavailable: true }
  }
}
