import type { Client } from "../../sql-client"
import { executeFirst } from "../../db-helpers"
import { makeId } from "../../helpers"
import { requiredString, rowValue, stringOrNull } from "../../sql-row"
import type { MembershipRequestSummary } from "../../../types"
import { upsertCommunityMembership } from "./membership-state-store"

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

export async function getCommunityJoinMode(client: Client, communityId: string): Promise<"open" | "request" | "gated" | null> {
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

  const mode = row ? requiredString(row, "membership_mode") : null
  return mode === "open" || mode === "request" || mode === "gated" ? mode : null
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
