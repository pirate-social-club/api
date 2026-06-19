import type { ReadClient } from "../../sql-client"
import { requiredString, rowValue, stringOrNull } from "../../sql-row"
import type { CommunityFollowStatus } from "./follow-store"

export type CommunityMembershipProjectionSourceRow = {
  community_id: string
  user_id: string
  membership_state: "not_member" | "member" | "banned"
  source_updated_at: string
}

export type CommunityFollowProjectionSourceRow = {
  community_id: string
  user_id: string
  follow_state: CommunityFollowStatus
  source_updated_at: string
  unfollowed_at: string | null
}

export async function listCommunityMembershipProjectionSources(input: {
  client: ReadClient
  communityId: string
  limit: number
}): Promise<CommunityMembershipProjectionSourceRow[]> {
  const result = await input.client.execute({
    sql: `
      SELECT community_id, user_id, status, updated_at
      FROM community_memberships
      WHERE community_id = ?1
      ORDER BY updated_at ASC, membership_id ASC
      LIMIT ?2
    `,
    args: [input.communityId, input.limit],
  })

  return result.rows.map((row) => {
    const status = requiredString(row, "status")
    return {
      community_id: requiredString(row, "community_id"),
      user_id: requiredString(row, "user_id"),
      membership_state: status === "banned" ? "banned" : status === "member" ? "member" : "not_member",
      source_updated_at: requiredString(row, "updated_at"),
    }
  })
}

export async function listCommunityFollowProjectionSources(input: {
  client: ReadClient
  communityId: string
  limit: number
}): Promise<CommunityFollowProjectionSourceRow[]> {
  const result = await input.client.execute({
    sql: `
      SELECT community_id, user_id, status, updated_at, unfollowed_at
      FROM community_follows
      WHERE community_id = ?1
      ORDER BY updated_at ASC, community_follow_id ASC
      LIMIT ?2
    `,
    args: [input.communityId, input.limit],
  })

  return result.rows.map((row) => ({
    community_id: requiredString(row, "community_id"),
    user_id: requiredString(row, "user_id"),
    follow_state: requiredString(row, "status") as CommunityFollowStatus,
    source_updated_at: requiredString(row, "updated_at"),
    unfollowed_at: stringOrNull(rowValue(row, "unfollowed_at")),
  }))
}
