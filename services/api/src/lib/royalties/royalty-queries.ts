import type { DbExecutor } from "../db-helpers"
import type { AssetRow } from "../communities/commerce/row-types"
import { stringOrNull, requiredString } from "../communities/commerce/row-types"

export type UserStoryAssetRow = Pick<AssetRow, "asset_id" | "community_id" | "display_title" | "story_ip_id" | "story_royalty_policy" | "story_derivative_parent_ip_ids_json">

export async function listUserStoryAssets(
  client: DbExecutor,
  userId: string,
): Promise<UserStoryAssetRow[]> {
  const result = await client.execute({
    sql: `
      SELECT asset_id, community_id, display_title, story_ip_id, story_royalty_policy, story_derivative_parent_ip_ids_json
      FROM assets
      WHERE creator_user_id = ?1
        AND story_ip_id IS NOT NULL
        AND story_ip_id != ''
        AND story_royalty_registration_status = 'registered'
      ORDER BY created_at DESC
    `,
    args: [userId],
  })

  return result.rows.map((row) => ({
    asset_id: requiredString(row, "asset_id"),
    community_id: requiredString(row, "community_id"),
    display_title: stringOrNull(row, "display_title"),
    story_ip_id: requiredString(row, "story_ip_id"),
    story_royalty_policy: stringOrNull(row, "story_royalty_policy"),
    story_derivative_parent_ip_ids_json: stringOrNull(row, "story_derivative_parent_ip_ids_json"),
  }))
}
