import type { DbExecutor } from "../../db-helpers"
import { notFoundError } from "../../errors"
import type { AssetPayloadDescriptor } from "../../../types"
import { assertPrimaryPayloadMatchesPolicy, isGenericAssetKind } from "./asset-kind-policy"
import { getActivePrimaryAssetPayload, getAssetEnforcement } from "./generic-asset-repository"
import { assertGenericEmergencyControlsClear } from "./generic-asset-emergency-controls"
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
  await assertGenericEmergencyControlsClear({
    client: input.client,
    context: {
      assetId: input.asset.asset_id,
      contentHash: payload.content_hash,
      uploaderUserId: input.asset.creator_user_id,
      communityId: input.asset.community_id,
      validationProfile: input.asset.asset_kind === "learning_deck" ? "deck_import_csv_v1" : "download_file_v1",
    },
    notFoundMessage: input.notFoundMessage,
  })
  return descriptor
}

export async function assertAssetDeliveryAllowed(input: {
  client: DbExecutor
  asset: AssetRow
  notFoundMessage: string
  /** Publication/locked-delivery workers may inspect a still-processing post,
   * but no buyer, creator, moderator, or public reader may deliver it. */
  allowProcessingPost?: boolean
}): Promise<void> {
  if (!isGenericAssetKind(input.asset.asset_kind)) return

  const enforcement = await getAssetEnforcement(input.client, input.asset.asset_id)
  if (!enforcement || enforcement.enforcement_state !== "active") {
    throw notFoundError(input.notFoundMessage)
  }
  const postResult = await input.client.execute({
    sql: `
      SELECT status
      FROM posts
      WHERE post_id = ?1 AND community_id = ?2
      LIMIT 1
    `,
    args: [input.asset.source_post_id, input.asset.community_id],
  })
  const postStatus = postResult.rows[0] && String((postResult.rows[0] as Record<string, unknown>).status)
  if (postStatus !== "published" && !(input.allowProcessingPost && postStatus === "processing")) {
    throw notFoundError(input.notFoundMessage)
  }
  const payload = await getActivePrimaryAssetPayload(input.client, input.asset.asset_id)
  if (!payload) throw notFoundError(input.notFoundMessage)
  await assertGenericEmergencyControlsClear({
    client: input.client,
    context: {
      assetId: input.asset.asset_id,
      contentHash: payload.content_hash,
      uploaderUserId: input.asset.creator_user_id,
      communityId: input.asset.community_id,
      validationProfile: input.asset.asset_kind === "learning_deck" ? "deck_import_csv_v1" : "download_file_v1",
    },
    notFoundMessage: input.notFoundMessage,
  })
}
