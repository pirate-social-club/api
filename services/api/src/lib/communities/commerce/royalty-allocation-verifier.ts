import type { Env } from "../../../env"
import { openCommunityWriteClient } from "../community-read-access"
import type { CommunityDatabaseBindingRepository, CommunityReadRepository } from "../community-repository-types"
import {
  listPendingStoryRoyaltyAllocationProjectionCommunities,
  syncStoryRoyaltyAllocationProjectionForAsset,
} from "./royalty-allocation-projection"
import {
  listPendingStoryRoyaltyAllocationAssets,
  type StoryRoyaltyAllocationVerificationResult,
  type StoryRoyaltyVaultReader,
  verifyStoryRoyaltyAllocationForAsset,
} from "./royalty-allocations"
import { createStoryRoyaltyVaultReader } from "./story-royalty-vault-reader"

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
  const communityIds = await listPendingStoryRoyaltyAllocationProjectionCommunities({
    env: input.env,
    limit: input.maxCommunities,
  })

  for (const communityId of communityIds) {
    const communitySummary = {
      community_id: communityId,
      checked: 0,
      verified: 0,
      pending: 0,
      skipped: 0,
      failed: 0,
    }
    let handle: Awaited<ReturnType<typeof openCommunityWriteClient>> | null = null
    try {
      handle = await openCommunityWriteClient(input.env, input.communityRepository, communityId)
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
      summary.failed_communities.push(communityId)
      console.warn("[royalty-allocation-verifier] community failed", {
        communityId,
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
