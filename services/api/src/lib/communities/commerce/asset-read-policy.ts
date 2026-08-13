import type { DbExecutor } from "../../db-helpers"
import { notFoundError } from "../../errors"
import type { AssetPayloadDescriptor } from "../../../types"
import { assertPrimaryPayloadMatchesPolicy, isGenericAssetKind } from "./asset-kind-policy"
import { getActivePrimaryAssetPayload, getAssetEnforcement } from "./generic-asset-repository"
import type { AssetRow } from "./row-types"

export async function resolveAssetPayloadDescriptor(input: {
  client: DbExecutor
  asset: AssetRow
  notFoundMessage: string
}): Promise<AssetPayloadDescriptor | null> {
  if (!isGenericAssetKind(input.asset.asset_kind)) return null

  const payload = await getActivePrimaryAssetPayload(input.client, input.asset.asset_id)
  if (!payload) {
    throw notFoundError(input.notFoundMessage)
  }
  const descriptor: AssetPayloadDescriptor = {
    delivery_behavior: payload.delivery_behavior,
    display_filename: payload.display_filename,
    mime_type: payload.mime_type,
    size_bytes: payload.size_bytes,
    content_hash: payload.content_hash,
    payload_format: payload.payload_format,
  }
  assertPrimaryPayloadMatchesPolicy({ assetKind: input.asset.asset_kind, payload: descriptor })
  return descriptor
}

export async function assertAssetDeliveryAllowed(input: {
  client: DbExecutor
  asset: AssetRow
  notFoundMessage: string
}): Promise<void> {
  if (!isGenericAssetKind(input.asset.asset_kind)) return

  const enforcement = await getAssetEnforcement(input.client, input.asset.asset_id)
  if (!enforcement || enforcement.enforcement_state !== "active") {
    throw notFoundError(input.notFoundMessage)
  }
}
