import type { Client } from "../sql-client"
import { executeFirst } from "../db-helpers"
import { makeId } from "../helpers"
import { requiredString, rowValue, stringOrNull } from "../sql-row"
import {
  type CommunityGateRuleRow,
  toCommunityGateRuleRow,
} from "./community-membership-gates"

export {
  buildMembershipGateSummary,
  evaluateMembershipGateRules,
  satisfiesMembershipGateRules,
  type CommunityGateRuleRow,
  type MembershipGateEvaluation,
} from "./community-membership-gates"

export type CommunityMembershipRow = {
  membership_status: "member" | "left" | "banned" | null
  role_status: "active" | "revoked" | null
}

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
