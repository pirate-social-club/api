import type { Client } from "../../sql-client"
import { executeFirst } from "../../db-helpers"
import { makeId } from "../../helpers"
import { requiredString, rowValue, stringOrNull } from "../../sql-row"
import { withTransaction } from "../../transactions"
import { upsertCommunityMembership } from "./membership-state-store"

type MembershipExecutor = Pick<Client, "execute">

export type MembershipRequestRow = {
  membership_request_id: string
  community_id: string
  applicant_user_id: string
  status: "pending" | "approved" | "rejected" | "expired"
  note: string | null
  created_at: string
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

export async function getCommunityJoinMode(client: Client, communityId: string): Promise<"request" | "gated" | null> {
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
  return mode === "request" || mode === "gated" ? mode : null
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
  // Read the pending request BEFORE the tx — a buffered D1 write tx can't surface
  // rowsAffected or read the row back mid-flight, and the approved-path membership
  // upsert needs the applicant_user_id. The UPDATE below stays guarded by
  // status='pending', so a concurrent resolve still can't double-apply.
  const existing = await executeFirst(input.client, {
    sql: `
      ${MEMBERSHIP_REQUEST_SELECT}
      WHERE community_id = ?1
        AND membership_request_id = ?2
        AND status = 'pending'
      LIMIT 1
    `,
    args: [input.communityId, input.requestId],
  })
  if (!existing) {
    return null
  }
  const request = toMembershipRequestRow(existing as Record<string, unknown>)
  const nextStatus = input.decision === "approved" ? "approved" : "rejected"

  await withTransaction(input.client, "write", async (tx) => {
    await tx.execute({
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
      args: [input.communityId, input.requestId, input.reviewerUserId, nextStatus, input.now],
    })

    if (input.decision === "approved") {
      await upsertCommunityMembership({
        client: tx,
        communityId: input.communityId,
        userId: request.applicant_user_id,
        now: input.now,
      })
    }

  })
  // Deterministic projection of the resolved row — the tx can't read it back.
  return { ...request, status: nextStatus, updated_at: input.now }
}
