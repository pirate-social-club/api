import { badRequestError } from "../../errors"
import { isLocalEnvironment } from "../../helpers"
import type { AssetRow } from "./row-types"
import type { Env } from "../../../env"
import type { Client } from "../../sql-client"
import { createStoryRoyaltyVaultReader } from "./story-royalty-vault-reader"
import {
  type StoryRoyaltyAllocationVerificationResult,
  type StoryRoyaltyVaultReader,
  verifyStoryRoyaltyAllocationForAsset,
} from "./royalty-allocations"

type StoryRoyaltyCommerceAsset = Pick<
  AssetRow,
  | "asset_id"
  | "community_id"
  | "asset_kind"
  | "story_ip_id"
  | "story_royalty_registration_status"
  | "story_status"
  | "locked_delivery_status"
  | "royalty_allocation_status"
>

export function assertAssetReadyForStoryRoyaltyCommerce(
  asset: Pick<AssetRow, "asset_kind" | "story_ip_id" | "story_royalty_registration_status" | "story_status" | "locked_delivery_status" | "royalty_allocation_status">,
  env?: Pick<Env, "ENVIRONMENT">,
): void {
  if (
    isLocalEnvironment(env?.ENVIRONMENT)
    && asset.story_status === "published"
    && (
      asset.locked_delivery_status === "ready"
      || (asset.story_royalty_registration_status === "registered" && Boolean(asset.story_ip_id?.trim()))
    )
  ) {
    return
  }
  if (asset.royalty_allocation_status !== "none" && asset.royalty_allocation_status !== "verified") {
    throw badRequestError("Asset royalty allocation is not verified")
  }
  if (asset.story_royalty_registration_status !== "registered" || !asset.story_ip_id?.trim()) {
    throw badRequestError("Asset is not ready for Story royalty commerce")
  }
}

/**
 * A quote is the last correctness boundary before money moves. If Story
 * registration finished but the background verifier has not reached this asset,
 * verify this exact vault once instead of making commerce depend on a global cron
 * queue. Pending/mismatched allocations still fail closed through the existing
 * readiness assertion.
 */
export async function ensureAssetReadyForStoryRoyaltyCommerce<T extends StoryRoyaltyCommerceAsset>(input: {
  asset: T
  client: Pick<Client, "execute" | "transaction">
  env: Env
  vaultReader?: StoryRoyaltyVaultReader
  verifyAllocation?: (input: {
    client: Pick<Client, "execute" | "transaction">
    communityId: string
    assetId: string
    vaultReader: StoryRoyaltyVaultReader
  }) => Promise<StoryRoyaltyAllocationVerificationResult>
}): Promise<T> {
  try {
    assertAssetReadyForStoryRoyaltyCommerce(input.asset, input.env)
    return input.asset
  } catch (readinessError) {
    if (input.asset.royalty_allocation_status !== "verification_pending") {
      throw readinessError
    }

    try {
      const result = await (input.verifyAllocation ?? verifyStoryRoyaltyAllocationForAsset)({
        client: input.client,
        communityId: input.asset.community_id,
        assetId: input.asset.asset_id,
        vaultReader: input.vaultReader ?? createStoryRoyaltyVaultReader(input.env),
      })
      if (result.status === "verified" || (result.status === "skipped" && result.reason === "already_verified")) {
        const verifiedAsset = { ...input.asset, royalty_allocation_status: "verified" as const } as T
        assertAssetReadyForStoryRoyaltyCommerce(verifiedAsset, input.env)
        return verifiedAsset
      }
      if (result.status === "pending") {
        console.info("[story-royalty-commerce] targeted allocation verification pending", {
          assetId: input.asset.asset_id,
          communityId: input.asset.community_id,
          reason: result.reason,
        })
      }
    } catch (error) {
      console.warn("[story-royalty-commerce] targeted allocation verification failed", {
        assetId: input.asset.asset_id,
        communityId: input.asset.community_id,
        error: error instanceof Error ? error.message : String(error),
      })
    }

    throw readinessError
  }
}
