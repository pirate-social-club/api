import { eligibilityFailed, notFoundError } from "../../errors"
import { getActiveRightsHoldForAsset, getActiveRightsHoldForSubject } from "../../rights/rights-hold-store"
import type { DbExecutor } from "../../db-helpers"
import type { AssetRow, ListingRow } from "./row-types"

type RightsHoldGateMode = "private" | "public"

function rightsHoldMessage(): string {
  return "This asset is unavailable while a rights review hold is active"
}

export function blockedRightsHoldMessage(): string {
  return "This asset is blocked by rights review"
}

function throwRightsHold(mode: RightsHoldGateMode): never {
  if (mode === "public") {
    throw notFoundError("Listing not found")
  }
  throw eligibilityFailed(rightsHoldMessage())
}

export async function assertAssetNotRightsHeld(input: {
  client: DbExecutor
  communityId: string
  asset: Pick<AssetRow, "asset_id" | "source_post_id">
  mode?: RightsHoldGateMode
}): Promise<void> {
  const hold = await getActiveRightsHoldForAsset({
    executor: input.client,
    communityId: input.communityId,
    assetId: input.asset.asset_id,
    sourcePostId: input.asset.source_post_id,
  })
  if (hold) {
    throwRightsHold(input.mode ?? "private")
  }
}

export async function assertAssetNotBlockedByRightsHold(input: {
  client: DbExecutor
  communityId: string
  asset: Pick<AssetRow, "asset_id" | "source_post_id">
}): Promise<void> {
  const hold = await getActiveRightsHoldForAsset({
    executor: input.client,
    communityId: input.communityId,
    assetId: input.asset.asset_id,
    sourcePostId: input.asset.source_post_id,
  })
  if (hold?.hold_type === "blocked") {
    throw eligibilityFailed(blockedRightsHoldMessage())
  }
}

export async function assertListingNotRightsHeld(input: {
  client: DbExecutor
  communityId: string
  listing: Pick<ListingRow, "asset_id" | "replay_asset_id" | "live_room_id">
  mode?: RightsHoldGateMode
}): Promise<void> {
  if (input.listing.asset_id?.trim()) {
    const hold = await getActiveRightsHoldForSubject({
      executor: input.client,
      communityId: input.communityId,
      subjectType: "asset",
      subjectId: input.listing.asset_id.trim(),
    })
    if (hold) throwRightsHold(input.mode ?? "private")
  }
  if (input.listing.replay_asset_id?.trim()) {
    const hold = await getActiveRightsHoldForSubject({
      executor: input.client,
      communityId: input.communityId,
      subjectType: "replay_asset",
      subjectId: input.listing.replay_asset_id.trim(),
    })
    if (hold) throwRightsHold(input.mode ?? "private")
  }
  if (input.listing.live_room_id?.trim()) {
    const hold = await getActiveRightsHoldForSubject({
      executor: input.client,
      communityId: input.communityId,
      subjectType: "live_room",
      subjectId: input.listing.live_room_id.trim(),
    })
    if (hold) throwRightsHold(input.mode ?? "private")
  }
}
