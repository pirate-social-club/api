import { createPublicClient, erc20Abi, fallback, http } from "viem"
import type { Env } from "../../../env"
import { resolveStoryChainId, resolveStoryRpcUrls } from "../../story/story-runtime-config"
import type { StoryRoyaltyVaultReader } from "./royalty-allocations"

type ViemChain = {
  id: number
  name: string
  nativeCurrency: { name: string; symbol: string; decimals: number }
  rpcUrls: { default: { http: string[] } }
}

function storyViemChain(
  env: Pick<Env, "STORY_CHAIN_ID" | "STORY_RPC_URL" | "STORY_RPC_FALLBACK_URLS">,
): ViemChain {
  const chainId = resolveStoryChainId(env)
  const urls = resolveStoryRpcUrls(env)
  return {
    id: chainId,
    name: chainId === 1514 ? "Story Mainnet" : "Story Aeneid",
    nativeCurrency: { name: "IP", symbol: "IP", decimals: 18 },
    rpcUrls: { default: { http: urls } },
  }
}

export function createStoryRoyaltyVaultReader(
  env: Pick<Env, "STORY_CHAIN_ID" | "STORY_RPC_URL" | "STORY_RPC_FALLBACK_URLS">,
): StoryRoyaltyVaultReader {
  const client = createPublicClient({
    chain: storyViemChain(env),
    transport: fallback(resolveStoryRpcUrls(env).map((url) => http(url))),
  })
  return {
    totalSupply: async (vaultAddress) => await client.readContract({
      address: vaultAddress,
      abi: erc20Abi,
      functionName: "totalSupply",
    }),
    decimals: async (vaultAddress) => Number(await client.readContract({
      address: vaultAddress,
      abi: erc20Abi,
      functionName: "decimals",
    })),
    balanceOf: async ({ vaultAddress, walletAddress }) => await client.readContract({
      address: vaultAddress,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [walletAddress],
    }),
  }
}
