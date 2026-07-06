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

export async function listProjectedRoyaltyAllocationStoryAssets(input: {
  client: DbExecutor
  userId: string
  walletAddressesNormalized: string[]
}): Promise<UserStoryAssetRow[]> {
  const walletAddresses = Array.from(new Set(
    input.walletAddressesNormalized
      .map((address) => address.trim().toLowerCase())
      .filter(Boolean),
  ))
  const filters = ["p.recipient_user_id = ?1"]
  const args: Array<string | number> = [input.userId]
  if (walletAddresses.length > 0) {
    const firstWalletArg = args.length + 1
    filters.push(`p.wallet_address_normalized IN (${walletAddresses.map((_, index) => `?${firstWalletArg + index}`).join(", ")})`)
    args.push(...walletAddresses)
  }

  const result = await input.client.execute({
    sql: `
      SELECT
        p.asset_id,
        p.community_id,
        srap.display_title,
        p.story_ip_id,
        NULL AS story_royalty_policy,
        NULL AS story_derivative_parent_ip_ids_json,
        MAX(p.updated_at) AS updated_at
      FROM story_royalty_allocation_projections p
      LEFT JOIN story_registered_asset_projections srap
        ON srap.community_id = p.community_id
       AND srap.asset_id = p.asset_id
      WHERE p.distribution_status = 'verified'
        AND p.story_ip_id IS NOT NULL
        AND p.story_ip_id != ''
        AND (${filters.join(" OR ")})
      GROUP BY p.asset_id, p.community_id, srap.display_title, p.story_ip_id
      ORDER BY updated_at DESC, p.asset_id DESC
    `,
    args,
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
