import { createPublicClient, erc20Abi, fallback, http } from "viem"
import type { Env } from "../../../env"
import { openCommunityWriteClient } from "../community-read-access"
import type { CommunityDatabaseBindingRepository, CommunityReadRepository } from "../community-repository-types"
import { syncStoryRoyaltyAllocationProjectionForAsset } from "./royalty-allocation-projection"
import {
  listPendingStoryRoyaltyAllocationAssets,
  type StoryRoyaltyAllocationVerificationResult,
  type StoryRoyaltyVaultReader,
  verifyStoryRoyaltyAllocationForAsset,
} from "./royalty-allocations"
import { resolveStoryChainId, resolveStoryRpcUrls } from "../../story/story-runtime-config"

type ViemChain = {
  id: number
  name: string
  nativeCurrency: { name: string; symbol: string; decimals: number }
  rpcUrls: { default: { http: string[] } }
}

export type RoyaltyAllocationVerificationSummary = {
  checked: number
  verified: number
  pending: number
  skipped: number
  failed: number
  communities: Array<{
    community_id: string
    checked: number
    verified: number
    pending: number
    skipped: number
    failed: number
  }>
  failed_communities: string[]
}

function storyViemChain(env: Pick<Env, "STORY_CHAIN_ID" | "STORY_RPC_URL" | "STORY_RPC_FALLBACK_URLS">): ViemChain {
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

function emptySummary(): RoyaltyAllocationVerificationSummary {
  return {
    checked: 0,
    verified: 0,
    pending: 0,
    skipped: 0,
    failed: 0,
    communities: [],
    failed_communities: [],
  }
}

function recordResult(
  summary: RoyaltyAllocationVerificationSummary,
  community: RoyaltyAllocationVerificationSummary["communities"][number],
  result: StoryRoyaltyAllocationVerificationResult,
): void {
  summary.checked += 1
  community.checked += 1
  if (result.status === "verified") {
    summary.verified += 1
    community.verified += 1
  } else if (result.status === "pending") {
    summary.pending += 1
    community.pending += 1
  } else {
    summary.skipped += 1
    community.skipped += 1
  }
}

export async function reconcileStoryRoyaltyAllocationVerifications(input: {
  env: Env
  communityRepository: CommunityDatabaseBindingRepository & CommunityReadRepository
  maxCommunities: number
  maxAssetsPerCommunity: number
  vaultReader?: StoryRoyaltyVaultReader
}): Promise<RoyaltyAllocationVerificationSummary> {
  const summary = emptySummary()
  const vaultReader = input.vaultReader ?? createStoryRoyaltyVaultReader(input.env)
  const communities = await input.communityRepository.listActiveCommunities({ limit: input.maxCommunities })

  for (const community of communities) {
    const communitySummary = {
      community_id: community.community_id,
      checked: 0,
      verified: 0,
      pending: 0,
      skipped: 0,
      failed: 0,
    }
    let handle: Awaited<ReturnType<typeof openCommunityWriteClient>> | null = null
    try {
      handle = await openCommunityWriteClient(input.env, input.communityRepository, community.community_id)
      const assets = await listPendingStoryRoyaltyAllocationAssets({
        client: handle.client,
        limit: input.maxAssetsPerCommunity,
      })
      for (const asset of assets) {
        try {
          const result = await verifyStoryRoyaltyAllocationForAsset({
            client: handle.client,
            communityId: asset.communityId,
            assetId: asset.assetId,
            vaultReader,
          })
          recordResult(summary, communitySummary, result)
          await syncStoryRoyaltyAllocationProjectionForAsset({
            env: input.env,
            client: handle.client,
            communityId: asset.communityId,
            assetId: asset.assetId,
          })
        } catch (error) {
          summary.failed += 1
          communitySummary.failed += 1
          console.warn("[royalty-allocation-verifier] asset failed", {
            communityId: asset.communityId,
            assetId: asset.assetId,
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
    } catch (error) {
      summary.failed += 1
      communitySummary.failed += 1
      summary.failed_communities.push(community.community_id)
      console.warn("[royalty-allocation-verifier] community failed", {
        communityId: community.community_id,
        error: error instanceof Error ? error.message : String(error),
      })
    } finally {
      if (communitySummary.checked > 0 || communitySummary.failed > 0) {
        summary.communities.push(communitySummary)
      }
      await handle?.close?.()
    }
  }

  return summary
}
