import type { Client } from "../../sql-client"
import { executeFirst } from "../../db-helpers"
import { rowValue, stringOrNull } from "../../sql-row"

export type CommunityMembershipRow = {
  membership_status: "member" | "left" | "banned" | null
  role_status: "active" | "revoked" | null
}

export async function getCommunityMembershipState(
  client: Client,
  communityId: string,
  userId: string,
): Promise<CommunityMembershipRow> {
  const row = await executeFirst(
    client,
    {
      sql: `
        SELECT
          (
            SELECT status
            FROM community_memberships
            WHERE community_id = ?1
              AND user_id = ?2
            ORDER BY created_at DESC
            LIMIT 1
          ) AS membership_status,
          (
            SELECT status
            FROM community_roles
            WHERE community_id = ?1
              AND user_id = ?2
              AND role IN ('owner', 'admin', 'moderator')
            ORDER BY created_at DESC
            LIMIT 1
          ) AS role_status
      `,
      args: [communityId, userId],
    },
  )

  return {
    membership_status: stringOrNull(rowValue(row, "membership_status")) as CommunityMembershipRow["membership_status"],
    role_status: stringOrNull(rowValue(row, "role_status")) as CommunityMembershipRow["role_status"],
  }
}

export function canAccessCommunity(state: CommunityMembershipRow): boolean {
  return state.membership_status === "member" || state.role_status === "active"
}

export async function getCommunityMemberCount(
  client: Client,
  communityId: string,
): Promise<number | null> {
  const row = await executeFirst(
    client,
    {
      sql: `
        SELECT cached_member_count
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [communityId],
    },
  )

  const value = rowValue(row, "cached_member_count")
  if (typeof value === "number") {
    return value
  }

  const countRow = await executeFirst(
    client,
    {
      sql: `
        SELECT COUNT(*) AS member_count
        FROM community_memberships
        WHERE community_id = ?1
          AND status = 'member'
      `,
      args: [communityId],
    },
  )
  const countValue = rowValue(countRow, "member_count")
  return typeof countValue === "number" ? countValue : null
}

export async function upsertCommunityMembership(input: {
  client: Pick<Client, "execute">
  communityId: string
  userId: string
  now: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      INSERT INTO community_memberships (
        membership_id, community_id, user_id, status, joined_at, left_at, banned_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, 'member', ?4, NULL, NULL, ?4, ?4
      )
      ON CONFLICT(membership_id) DO UPDATE SET
        status = excluded.status,
        joined_at = excluded.joined_at,
        left_at = excluded.left_at,
        banned_at = excluded.banned_at,
        updated_at = excluded.updated_at
    `,
    args: [`mbr_${input.communityId}_${input.userId}`, input.communityId, input.userId, input.now],
  })
}
