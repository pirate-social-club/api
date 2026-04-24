import type { Client } from "../../sql-client"
import { executeFirst } from "../../db-helpers"
import { makeId } from "../../helpers"
import { requiredString, rowValue, stringOrNull } from "../../sql-row"
import type { MembershipRequestSummary } from "../../../types"
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

type MembershipExecutor = Pick<Client, "execute">

type MembershipRequestRow = MembershipRequestSummary & {
  updated_at: string
}

function toMembershipRequestRow(row: Record<string, unknown>): MembershipRequestRow {
  return {
    membership_request_id: requiredString(row, "membership_request_id"),
    community_id: requiredString(row, "community_id"),
    applicant_user_id: requiredString(row, "applicant_user_id"),
    status: requiredString(row, "status") as MembershipRequestRow["status"],
    note: stringOrNull(rowValue(row, "note")),
    created_at: requiredString(row, "created_at"),
    updated_at: requiredString(row, "updated_at"),
  }
}

const MEMBERSHIP_REQUEST_SELECT = `
  SELECT membership_request_id, community_id, applicant_user_id, status, note, created_at, updated_at
  FROM membership_requests
`

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
  client: MembershipExecutor
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
  client: MembershipExecutor
  communityId: string
  userId: string
  note?: string | null
  now: string
}): Promise<MembershipRequestRow> {
  const note = input.note?.trim() ? input.note.trim().slice(0, 500) : null
  await input.client.execute({
    sql: `
      INSERT INTO membership_requests (
        membership_request_id, community_id, applicant_user_id, status, note, reviewed_by_user_id,
        review_reason, resolved_at, expires_at, created_at, updated_at
      ) VALUES (
        ?1, ?2, ?3, 'pending', ?4, NULL,
        NULL, NULL, NULL, ?5, ?5
      )
      ON CONFLICT(community_id, applicant_user_id) WHERE status = 'pending' DO UPDATE SET
        note = excluded.note,
        updated_at = excluded.updated_at
    `,
    args: [makeId("mrq"), input.communityId, input.userId, note, input.now],
  })

  const row = await getPendingMembershipRequestByApplicant({
    client: input.client,
    communityId: input.communityId,
    userId: input.userId,
  })
  if (!row) {
    throw new Error("Pending membership request row missing after upsert")
  }
  return row
}

export async function getPendingMembershipRequestByApplicant(input: {
  client: MembershipExecutor
  communityId: string
  userId: string
}): Promise<MembershipRequestRow | null> {
  const row = await executeFirst(input.client, {
    sql: `
      ${MEMBERSHIP_REQUEST_SELECT}
      WHERE community_id = ?1
        AND applicant_user_id = ?2
        AND status = 'pending'
      LIMIT 1
    `,
    args: [input.communityId, input.userId],
  })
  return row ? toMembershipRequestRow(row as Record<string, unknown>) : null
}

export async function listPendingMembershipRequests(input: {
  client: MembershipExecutor
  communityId: string
  cursor?: string | null
  limit?: number
}): Promise<{ items: MembershipRequestRow[]; next_cursor: string | null }> {
  const limit = Math.min(100, Math.max(1, input.limit ?? 25))
  const cursor = input.cursor?.trim() || null
  const result = await input.client.execute({
    sql: cursor
      ? `
        ${MEMBERSHIP_REQUEST_SELECT}
        WHERE community_id = ?1
          AND status = 'pending'
          AND created_at < ?2
        ORDER BY created_at DESC, membership_request_id DESC
        LIMIT ?3
      `
      : `
        ${MEMBERSHIP_REQUEST_SELECT}
        WHERE community_id = ?1
          AND status = 'pending'
        ORDER BY created_at DESC, membership_request_id DESC
        LIMIT ?2
      `,
    args: cursor ? [input.communityId, cursor, limit + 1] : [input.communityId, limit + 1],
  })
  const rows = result.rows.map(toMembershipRequestRow)
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  return {
    items,
    next_cursor: hasMore && items.length > 0 ? items[items.length - 1].created_at : null,
  }
}

export async function countPendingMembershipRequests(input: {
  client: MembershipExecutor
  communityId: string
}): Promise<number> {
  const row = await executeFirst(input.client, {
    sql: `
      SELECT COUNT(*) AS count
      FROM membership_requests
      WHERE community_id = ?1
        AND status = 'pending'
    `,
    args: [input.communityId],
  })
  return Number(rowValue(row, "count") ?? 0)
}

export async function resolveMembershipRequest(input: {
  client: Client
  communityId: string
  requestId: string
  reviewerUserId: string
  decision: "approved" | "rejected"
  now: string
}): Promise<MembershipRequestRow | null> {
  const tx = await input.client.transaction("write")
  try {
    const updated = await tx.execute({
      sql: `
        UPDATE membership_requests
        SET status = ?4,
            reviewed_by_user_id = ?3,
            resolved_at = ?5,
            updated_at = ?5
        WHERE community_id = ?1
          AND membership_request_id = ?2
          AND status = 'pending'
      `,
      args: [
        input.communityId,
        input.requestId,
        input.reviewerUserId,
        input.decision === "approved" ? "approved" : "rejected",
        input.now,
      ],
    })
    if (!updated.rowsAffected || updated.rowsAffected === 0) {
      await tx.rollback()
      tx.close()
      return null
    }

    const selected = await executeFirst(tx, {
      sql: `
        ${MEMBERSHIP_REQUEST_SELECT}
        WHERE community_id = ?1
          AND membership_request_id = ?2
        LIMIT 1
      `,
      args: [input.communityId, input.requestId],
    })
    if (!selected) {
      await tx.rollback()
      tx.close()
      return null
    }
    const request = toMembershipRequestRow(selected as Record<string, unknown>)

    if (input.decision === "approved") {
      await upsertCommunityMembership({
        client: tx,
        communityId: input.communityId,
        userId: request.applicant_user_id,
        now: input.now,
      })
    }

    await tx.commit()
    tx.close()
    return request
  } catch (error) {
    await tx.rollback().catch(() => {})
    tx.close()
    throw error
  }
}
