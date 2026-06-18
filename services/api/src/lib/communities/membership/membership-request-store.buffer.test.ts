import { describe, expect, test } from "bun:test"
import { resolveMembershipRequest } from "./membership-request-store"
import type { Client } from "../../sql-client"

/**
 * Buffer-safety regression for resolveMembershipRequest. Under the D1 buffering
 * client, a write tx can neither surface rowsAffected nor read a row back mid-flight,
 * yet this path needs the applicant_user_id (to upsert membership) and the resolved
 * row. The pending-request read must therefore run on the base client BEFORE the tx,
 * and the tx body must be write-only. The recording client records base-client vs
 * in-tx statements; the test fails if any read leaks into the tx.
 */
const PENDING_ROW = {
  membership_request_id: "mrq_1",
  community_id: "cmt_m",
  applicant_user_id: "usr_applicant",
  status: "pending",
  note: null,
  created_at: "2026-06-10T00:00:00.000Z",
  updated_at: "2026-06-10T00:00:00.000Z",
}

function recordingClient(existingRow: Record<string, unknown> | null) {
  const baseSqls: string[] = []
  const txSqls: string[] = []
  const client = {
    execute: async (statement: { sql: string } | string) => {
      baseSqls.push(typeof statement === "string" ? statement : statement.sql)
      return { rows: existingRow ? [existingRow] : [] }
    },
    transaction: async (_mode: "write" | "read") => ({
      execute: async (statement: { sql: string } | string) => {
        txSqls.push(typeof statement === "string" ? statement : statement.sql)
        return { rows: [] }
      },
      commit: async () => {},
      rollback: async () => {},
      close: () => {},
    }),
  } as unknown as Client
  return { client, baseSqls, txSqls }
}

const hasRead = (sqls: string[]) =>
  sqls.some((s) => /pragma/i.test(s)) || sqls.some((s) => /^\s*select\b/i.test(s))

describe("resolveMembershipRequest (buffer-safe)", () => {
  test("approve: pending read runs pre-tx; tx does UPDATE + membership upsert, no in-tx read", async () => {
    const { client, baseSqls, txSqls } = recordingClient(PENDING_ROW)
    const result = await resolveMembershipRequest({
      client,
      communityId: "cmt_m",
      requestId: "mrq_1",
      reviewerUserId: "usr_reviewer",
      decision: "approved",
      now: "2026-06-17T00:00:00.000Z",
    })

    expect(result).toEqual({
      membership_request_id: "mrq_1",
      community_id: "cmt_m",
      applicant_user_id: "usr_applicant",
      status: "approved",
      note: null,
      created_at: "2026-06-10T00:00:00.000Z",
      updated_at: "2026-06-17T00:00:00.000Z",
    })
    expect(hasRead(baseSqls)).toBe(true) // pending read happened pre-tx
    expect(hasRead(txSqls)).toBe(false) // no read leaked into the buffered tx
    expect(txSqls.some((s) => /update\s+membership_requests/i.test(s))).toBe(true)
    expect(txSqls.some((s) => /insert\s+into\s+community_memberships/i.test(s))).toBe(true)
  })

  test("reject: no membership upsert in the tx", async () => {
    const { client, txSqls } = recordingClient(PENDING_ROW)
    const result = await resolveMembershipRequest({
      client,
      communityId: "cmt_m",
      requestId: "mrq_1",
      reviewerUserId: "usr_reviewer",
      decision: "rejected",
      now: "2026-06-17T00:00:00.000Z",
    })

    expect(result?.status).toBe("rejected")
    expect(hasRead(txSqls)).toBe(false)
    expect(txSqls.some((s) => /update\s+membership_requests/i.test(s))).toBe(true)
    expect(txSqls.some((s) => /insert\s+into\s+community_memberships/i.test(s))).toBe(false)
  })

  test("no pending row: returns null without opening a tx", async () => {
    const { client, txSqls } = recordingClient(null)
    const result = await resolveMembershipRequest({
      client,
      communityId: "cmt_m",
      requestId: "mrq_1",
      reviewerUserId: "usr_reviewer",
      decision: "approved",
      now: "2026-06-17T00:00:00.000Z",
    })

    expect(result).toBeNull()
    expect(txSqls.length).toBe(0)
  })
})
