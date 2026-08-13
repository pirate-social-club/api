import type { Asset, AssetPayloadDescriptor } from "../../../types"
import type { AssetRow } from "./row-types"

export type AssetKind = Asset["asset_kind"]

export type AssetKindPolicy = {
  assetKind: AssetKind
  primaryPayloadFormat: string
  deliveryBehavior: AssetPayloadDescriptor["delivery_behavior"]
  supportsDerivatives: boolean
  paidAccess: "locked_only" | "existing_rules"
  storyPublication: "required" | "optional" | "none"
}

const ASSET_KIND_POLICIES: Readonly<Record<AssetKind, AssetKindPolicy>> = {
  song_audio: {
    assetKind: "song_audio",
    primaryPayloadFormat: "song_artifact_v1",
    deliveryBehavior: "audio",
    supportsDerivatives: true,
    paidAccess: "existing_rules",
    storyPublication: "required",
  },
  video_file: {
    assetKind: "video_file",
    primaryPayloadFormat: "video_artifact_v1",
    deliveryBehavior: "video",
    supportsDerivatives: true,
    paidAccess: "existing_rules",
    storyPublication: "required",
  },
  download_file: {
    assetKind: "download_file",
    primaryPayloadFormat: "opaque_file_v1",
    deliveryBehavior: "download",
    supportsDerivatives: false,
    paidAccess: "locked_only",
    storyPublication: "required",
  },
  learning_deck: {
    assetKind: "learning_deck",
    primaryPayloadFormat: "learning_deck_package_v1",
    deliveryBehavior: "app_native",
    supportsDerivatives: false,
    paidAccess: "locked_only",
    storyPublication: "required",
  },
}

export function getAssetKindPolicy(assetKind: string): AssetKindPolicy {
  if (!Object.prototype.hasOwnProperty.call(ASSET_KIND_POLICIES, assetKind)) {
    throw new Error(`Unsupported asset kind: ${assetKind}`)
  }
  return ASSET_KIND_POLICIES[assetKind as AssetKind]
}

export function isGenericAssetKind(assetKind: string): assetKind is "download_file" | "learning_deck" {
  return assetKind === "download_file" || assetKind === "learning_deck"
}

export type LegacyMediaAssetRow = AssetRow & {
  asset_kind: "song_audio" | "video_file"
  primary_content_ref: string
}

export function assertLegacyMediaAsset(asset: AssetRow): asserts asset is LegacyMediaAssetRow {
  if ((asset.asset_kind !== "song_audio" && asset.asset_kind !== "video_file") || !asset.primary_content_ref?.trim()) {
    throw new Error("Legacy media path requires a song or video asset with primary content")
  }
}

export function assertPrimaryPayloadMatchesPolicy(input: {
  assetKind: string
  payload: AssetPayloadDescriptor
}): void {
  const policy = getAssetKindPolicy(input.assetKind)
  if (input.payload.delivery_behavior !== policy.deliveryBehavior) {
    throw new Error(`Primary payload delivery behavior does not match ${policy.assetKind} policy`)
  }
  if (input.payload.payload_format !== policy.primaryPayloadFormat) {
    throw new Error(`Primary payload format does not match ${policy.assetKind} policy`)
  }
  if (policy.deliveryBehavior === "download" && !input.payload.display_filename?.trim()) {
    throw new Error("Download payload requires a display filename")
  }
  if (!input.payload.mime_type.trim() || input.payload.size_bytes <= 0 || !input.payload.content_hash.trim()) {
    throw new Error("Primary payload metadata is incomplete")
  }
}
