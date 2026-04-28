import type { Client } from "../../sql-client"
import { executeFirst } from "../../db-helpers"
import { rowValue, stringOrNull } from "../../sql-row"

export type CommunityFollowStatus = "active" | "inactive"

export async function getCommunityFollowStatus(
  client: Client,
  communityId: string,
  userId: string,
): Promise<CommunityFollowStatus | null> {
  const row = await executeFirst(
    client,
    {
      sql: `
        SELECT status
        FROM community_follows
        WHERE community_id = ?1
          AND user_id = ?2
        LIMIT 1
      `,
      args: [communityId, userId],
    },
  )

  const status = stringOrNull(rowValue(row, "status"))
  return status === "active" || status === "inactive" ? status : null
}

export async function getCommunityFollowerCount(
  client: Client,
  communityId: string,
): Promise<number | null> {
  const row = await executeFirst(
    client,
    {
      sql: `
        SELECT cached_follower_count
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [communityId],
    },
  )

  const value = rowValue(row, "cached_follower_count")
  return typeof value === "number" ? value : null
}

export async function setCommunityFollowActive(input: {
  client: Client
  communityId: string
  userId: string
  now: string
}): Promise<{ changed: boolean; followerCount: number | null }> {
  const previousStatus = await getCommunityFollowStatus(input.client, input.communityId, input.userId)

  await input.client.execute({
    sql: `
      INSERT INTO community_follows (
        community_follow_id, community_id, user_id, status, unfollowed_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, 'active', NULL, ?4, ?4
      )
      ON CONFLICT(community_id, user_id) DO UPDATE SET
        status = 'active',
        unfollowed_at = NULL,
        updated_at = excluded.updated_at
    `,
    args: [`flw_${input.communityId}_${input.userId}`, input.communityId, input.userId, input.now],
  })

  if (previousStatus !== "active") {
    await input.client.execute({
      sql: `
        UPDATE communities
        SET cached_follower_count = COALESCE(cached_follower_count, 0) + 1,
            updated_at = ?2
        WHERE community_id = ?1
      `,
      args: [input.communityId, input.now],
    })
  }

  return {
    changed: previousStatus !== "active",
    followerCount: await getCommunityFollowerCount(input.client, input.communityId),
  }
}

export async function setCommunityFollowInactive(input: {
  client: Client
  communityId: string
  userId: string
  now: string
}): Promise<{ changed: boolean; followerCount: number | null }> {
  const previousStatus = await getCommunityFollowStatus(input.client, input.communityId, input.userId)

  if (previousStatus == null) {
    return {
      changed: false,
      followerCount: await getCommunityFollowerCount(input.client, input.communityId),
    }
  }

  await input.client.execute({
    sql: `
      UPDATE community_follows
      SET status = 'inactive',
          unfollowed_at = ?3,
          updated_at = ?3
      WHERE community_id = ?1
        AND user_id = ?2
    `,
    args: [input.communityId, input.userId, input.now],
  })

  if (previousStatus === "active") {
    await input.client.execute({
      sql: `
        UPDATE communities
        SET cached_follower_count = MAX(COALESCE(cached_follower_count, 0) - 1, 0),
            updated_at = ?2
        WHERE community_id = ?1
      `,
      args: [input.communityId, input.now],
    })
  }

  return {
    changed: previousStatus === "active",
    followerCount: await getCommunityFollowerCount(input.client, input.communityId),
  }
}
