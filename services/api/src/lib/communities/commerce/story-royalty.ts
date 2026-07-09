import { badRequestError } from "../../errors"
import { isLocalEnvironment } from "../../helpers"
import type { AssetRow } from "./row-types"
import type { Env } from "../../../env"

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
