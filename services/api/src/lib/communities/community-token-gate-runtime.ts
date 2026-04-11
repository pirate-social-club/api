import { createPublicClient, getAddress, http, type Address, type PublicClient } from "viem"

import type { Env, WalletAttachmentSummary } from "../../types"
import type { CommunityGateRuleRow } from "./community-membership-store"

const DEFAULT_RPC_URLS: Record<string, string> = {
  "eip155:1": "https://eth.llamarpc.com",
  "eip155:137": "https://polygon-rpc.com",
}

const erc721BalanceOfAbi = [
  {
    inputs: [{ name: "owner", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const

const erc1155BalanceOfAbi = [
  {
    inputs: [
      { name: "account", type: "address" },
      { name: "id", type: "uint256" },
    ],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const

// RPC clients are cached per URL for the process lifetime. V1 uses a tiny,
// effectively fixed URL set, so a module-level cache is sufficient here.
const clientCache = new Map<string, PublicClient>()

type TokenOwnershipReader = (input: {
  rpcUrl: string
  chainNamespace: string
  contractAddress: Address
  walletAddress: Address
  gateType: "erc721_holding" | "erc1155_holding"
  tokenId?: bigint
}) => Promise<bigint>

function resolveRpcUrl(env: Env, chainNamespace: string): string | null {
  if (chainNamespace === "eip155:1") {
    return String(env.ETHEREUM_MAINNET_RPC_URL || DEFAULT_RPC_URLS[chainNamespace] || "").trim() || null
  }

  if (chainNamespace === "eip155:137") {
    return String(env.POLYGON_MAINNET_RPC_URL || DEFAULT_RPC_URLS[chainNamespace] || "").trim() || null
  }

  return null
}

function getClient(rpcUrl: string): PublicClient {
  const existing = clientCache.get(rpcUrl)
  if (existing) {
    return existing
  }

  const client = createPublicClient({
    transport: http(rpcUrl),
  })
  clientCache.set(rpcUrl, client)
  return client
}

function readBigIntString(value: unknown): bigint | null {
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return BigInt(value.trim())
  }
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return BigInt(value)
  }
  if (typeof value === "bigint" && value >= 0n) {
    return value
  }

  return null
}

function normalizeWalletAddress(value: string): Address | null {
  try {
    return getAddress(value)
  } catch {
    return null
  }
}

const defaultTokenOwnershipReader: TokenOwnershipReader = async (input) => {
  const client = getClient(input.rpcUrl)
  if (input.gateType === "erc721_holding") {
    return await client.readContract({
      address: input.contractAddress,
      abi: erc721BalanceOfAbi,
      functionName: "balanceOf",
      args: [input.walletAddress],
    })
  }

  return await client.readContract({
    address: input.contractAddress,
    abi: erc1155BalanceOfAbi,
    functionName: "balanceOf",
    args: [input.walletAddress, input.tokenId ?? 0n],
  })
}

export async function evaluateTokenHoldingGate(input: {
  env: Env
  rule: CommunityGateRuleRow
  gateConfig: Record<string, unknown> | null
  wallets: WalletAttachmentSummary[]
  readTokenOwnership?: TokenOwnershipReader
}): Promise<boolean> {
  if (input.rule.gate_family !== "token_holding") {
    return false
  }

  if (input.rule.gate_type !== "erc721_holding" && input.rule.gate_type !== "erc1155_holding") {
    return false
  }

  const chainNamespace = input.rule.chain_namespace?.trim()
  if (!chainNamespace) {
    return false
  }

  const rpcUrl = resolveRpcUrl(input.env, chainNamespace)
  if (!rpcUrl) {
    return false
  }

  const contractAddressValue = typeof input.gateConfig?.contract_address === "string"
    ? input.gateConfig.contract_address
    : null
  if (!contractAddressValue) {
    return false
  }

  let contractAddress: Address
  try {
    contractAddress = getAddress(contractAddressValue)
  } catch {
    return false
  }

  const matchingWallets = input.wallets.filter((wallet) => wallet.chain_namespace === chainNamespace)
  if (matchingWallets.length === 0) {
    return false
  }

  const readTokenOwnership = input.readTokenOwnership ?? defaultTokenOwnershipReader
  const tokenId = input.rule.gate_type === "erc1155_holding"
    ? readBigIntString(input.gateConfig?.token_id)
    : null
  const minimumBalance = input.rule.gate_type === "erc1155_holding"
    ? readBigIntString(input.gateConfig?.min_balance)
    : null

  if (input.rule.gate_type === "erc1155_holding" && (tokenId == null || minimumBalance == null || minimumBalance < 1n)) {
    return false
  }

  for (const wallet of matchingWallets) {
    const walletAddress = normalizeWalletAddress(wallet.wallet_address)
    if (!walletAddress) {
      continue
    }

    try {
      const balance = await readTokenOwnership({
        rpcUrl,
        chainNamespace,
        contractAddress,
        walletAddress,
        gateType: input.rule.gate_type,
        tokenId: tokenId ?? undefined,
      })

      if (input.rule.gate_type === "erc721_holding" && balance >= 1n) {
        return true
      }
      if (input.rule.gate_type === "erc1155_holding" && balance >= (minimumBalance ?? 1n)) {
        return true
      }
    } catch {
      continue
    }
  }

  return false
}
