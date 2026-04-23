import type { Client } from "../../sql-client"
import { executeFirst } from "../../db-helpers"
import { makeId } from "../../helpers"
import { requiredString, rowValue, stringOrNull } from "../../sql-row"
import {
  type CommunityGateRuleRow,
  toCommunityGateRuleRow,
} from "./gates"

export {
  buildMembershipGateSummary,
  evaluateMembershipGateRules,
  satisfiesMembershipGateRules,
  type CommunityGateRuleRow,
  type MembershipGateEvaluation,
} from "./gates"

export type CommunityMembershipRow = {
  membership_status: "member" | "left" | "banned" | null
  role_status: "active" | "revoked" | null
}

export type CommunityFollowStatus = "active" | "inactive"

type CommunityJoinModeRow = {
  membership_mode: "open" | "request" | "gated"
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
              AND role = 'owner'
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

export async function getCommunityJoinMode(client: Client, communityId: string): Promise<CommunityJoinModeRow["membership_mode"] | null> {
  const row = await executeFirst(
    client,
    {
      sql: `
        SELECT membership_mode
        FROM communities
        WHERE community_id = ?1
        LIMIT 1
      `,
      args: [communityId],
    },
  )

  return row ? requiredString(row, "membership_mode") as CommunityJoinModeRow["membership_mode"] : null
}

export async function listActiveMembershipGateRules(client: Client, communityId: string): Promise<CommunityGateRuleRow[]> {
  const result = await client.execute({
    sql: `
      SELECT gate_rule_id, scope, gate_family, gate_type, proof_requirements_json, chain_namespace, gate_config_json, status
      FROM community_gate_rules
      WHERE community_id = ?1
        AND scope = 'membership'
        AND status = 'active'
      ORDER BY created_at ASC
    `,
    args: [communityId],
  })

  return result.rows.map((row) => toCommunityGateRuleRow(row))
}

export async function upsertCommunityMembership(input: {
  client: Client
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

export async function upsertMembershipRequest(input: {
  client: Client
  communityId: string
  userId: string
  now: string
}): Promise<void> {
  await input.client.execute({
    sql: `
      INSERT INTO membership_requests (
        membership_request_id, community_id, applicant_user_id, status, note, reviewed_by_user_id,
        review_reason, resolved_at, expires_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, 'pending', NULL, NULL,
        NULL, NULL, NULL, ?4, ?4
      )
      ON CONFLICT(community_id, applicant_user_id) WHERE status = 'pending' DO UPDATE SET
        updated_at = excluded.updated_at
    `,
    args: [makeId("mrq"), input.communityId, input.userId, input.now],
  })
}
