import { badRequestError } from "../errors"
import { isLocalEnvironment } from "../helpers"
import type { AssetRow } from "./community-commerce-row-types"
import type { Env } from "../../types"

export function assertAssetReadyForStoryRoyaltyCommerce(
  asset: Pick<AssetRow, "story_ip_id" | "story_royalty_registration_status" | "story_status" | "locked_delivery_status">,
  env?: Pick<Env, "ENVIRONMENT">,
): void {
  if (
    isLocalEnvironment(env?.ENVIRONMENT)
    && asset.story_status === "published"
    && asset.locked_delivery_status === "ready"
  ) {
    return
  }
  if (asset.story_royalty_registration_status !== "registered" || !asset.story_ip_id?.trim()) {
    throw badRequestError("Asset is not ready for Story royalty commerce")
  }
}
