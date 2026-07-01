import type { ReadClient } from "../../sql-client"
import { executeFirst } from "../../db-helpers"
import { rowValue, stringOrNull } from "../../sql-row"

export type MembershipExecutor = Pick<ReadClient, "execute">

export type CommunityRole = "owner" | "admin" | "moderator"

export type CommunityMembershipRow = {
  membership_status: "member" | "left" | "banned" | null
  role: CommunityRole | null
  role_status: "active" | "revoked" | null
}

export const ANY_COMMUNITY_ROLE = ["owner", "admin", "moderator"] as const satisfies readonly CommunityRole[]
export const OWNER_OR_ADMIN_ROLE = ["owner", "admin"] as const satisfies readonly CommunityRole[]
export const OWNER_ROLE = ["owner"] as const satisfies readonly CommunityRole[]

export async function getCommunityMembershipState(
  client: MembershipExecutor,
  communityId: string,
  userId: string,
): Promise<CommunityMembershipRow> {
  const activeMemberRow = await executeFirst(
    client,
    {
      sql: `
        SELECT status
        FROM community_memberships
        WHERE community_id = ?1
          AND user_id = ?2
          AND status = 'member'
        LIMIT 1
      `,
      args: [communityId, userId],
    },
  )
  const activeRoleRow = await executeFirst(
    client,
    {
      sql: `
        SELECT role
        FROM community_roles
        WHERE community_id = ?1
          AND user_id = ?2
          AND role IN ('owner', 'admin', 'moderator')
          AND status = 'active'
        ORDER BY CASE role
          WHEN 'owner' THEN 0
          WHEN 'admin' THEN 1
          ELSE 2
        END
        LIMIT 1
      `,
      args: [communityId, userId],
    },
  )

  const membershipStatus = activeMemberRow
    ? "member"
    : stringOrNull(rowValue(await executeFirst(
      client,
      {
        sql: `
          SELECT status
          FROM community_memberships
          WHERE community_id = ?1
            AND user_id = ?2
          ORDER BY created_at DESC
          LIMIT 1
        `,
        args: [communityId, userId],
      },
    ), "status")) as CommunityMembershipRow["membership_status"]

  const role = stringOrNull(rowValue(activeRoleRow, "role")) as CommunityMembershipRow["role"]
  const roleStatus = role
    ? "active"
    : stringOrNull(rowValue(await executeFirst(
      client,
      {
        sql: `
          SELECT status
          FROM community_roles
          WHERE community_id = ?1
            AND user_id = ?2
            AND role IN ('owner', 'admin', 'moderator')
            AND status = 'revoked'
          LIMIT 1
        `,
        args: [communityId, userId],
      },
    ), "status")) as CommunityMembershipRow["role_status"]

  return {
    membership_status: membershipStatus,
    role,
    role_status: roleStatus,
  }
}

export function hasCommunityRole(state: CommunityMembershipRow, allowed: readonly CommunityRole[]): boolean {
  return state.role_status === "active" && state.role != null && allowed.includes(state.role)
}

export function canAccessCommunity(state: CommunityMembershipRow): boolean {
  return state.membership_status === "member" || hasCommunityRole(state, ANY_COMMUNITY_ROLE)
}

export async function getCommunityMemberCount(
  client: MembershipExecutor,
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
          -- Subscriber count: exclude drive-by inline-PoW participants
          -- (participation_source='comment_pow'). See migration 1116.
          AND participation_source = 'join'
      `,
      args: [communityId],
    },
  )
  const countValue = rowValue(countRow, "member_count")
  return typeof countValue === "number" ? countValue : null
}

export type MembershipParticipationSource = "join" | "comment_pow"

export async function upsertCommunityMembership(input: {
  client: MembershipExecutor
  communityId: string
  userId: string
  now: string
  /**
   * How this membership came to exist. Defaults to "join" (a real subscriber).
   * "comment_pow" marks a drive-by inline-PoW commenter who was auto-enrolled
   * only to author a comment; such rows are excluded from subscriber counts and
   * rosters. See migration 1116.
   */
  participationSource?: MembershipParticipationSource
}): Promise<void> {
  const participationSource: MembershipParticipationSource = input.participationSource ?? "join"
  await input.client.execute({
    sql: `
      INSERT INTO community_memberships (
        membership_id, community_id, user_id, status, joined_at, left_at, banned_at, created_at, updated_at, participation_source
      ) VALUES (
        ?1, ?2, ?3, 'member', ?4, NULL, NULL, ?4, ?4, ?5
      )
      ON CONFLICT(membership_id) DO UPDATE SET
        status = excluded.status,
        joined_at = excluded.joined_at,
        left_at = excluded.left_at,
        banned_at = excluded.banned_at,
        updated_at = excluded.updated_at,
        -- 'join' wins: a real join upgrades an existing 'comment_pow'; a
        -- comment-driven upsert ('comment_pow') never clobbers an existing
        -- value (so re-commenting can't downgrade a subscriber). Pinned by test.
        participation_source = CASE
          WHEN excluded.participation_source = 'join' THEN 'join'
          ELSE community_memberships.participation_source
        END
    `,
    args: [`mbr_${input.communityId}_${input.userId}`, input.communityId, input.userId, input.now, participationSource],
  })
}
