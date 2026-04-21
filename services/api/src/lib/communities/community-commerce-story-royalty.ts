import { badRequestError } from "../errors"
import type { AssetRow } from "./community-commerce-row-types"

export function assertAssetReadyForStoryRoyaltyCommerce(
  asset: Pick<AssetRow, "story_ip_id" | "story_royalty_registration_status">,
): void {
  if (asset.story_royalty_registration_status !== "registered" || !asset.story_ip_id?.trim()) {
    throw badRequestError("Asset is not ready for Story royalty commerce")
  }
}
