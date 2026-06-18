import { describe, expect, test } from "bun:test"
import { grantCommunityRoleOnClient, revokeCommunityRoleOnClient } from "./community-role-service"
import type { Client } from "../sql-client"

/**
 * Buffer-safety regressions for the role grant/revoke write paths. Under the D1
 * buffering client a SELECT issued INSIDE a write tx sees nothing until commit, so
 * the existence read must run on the base client BEFORE the tx and the tx body must
 * be write-only. This recording client records base-client statements separately
 * from in-tx statements; the tests fail if a read leaks into the tx, or if the
 * pre-tx read is dropped.
 */
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

describe("community role grant/revoke (buffer-safe)", () => {
  test("grant: existence read runs on base client, tx is INSERT-only", async () => {
    const { client, baseSqls, txSqls } = recordingClient(null)
    const changed = await grantCommunityRoleOnClient(client, {
      communityId: "cmt_r",
      targetUserId: "usr_t",
      role: "moderator",
      grantedByUserId: "usr_a",
      now: "2026-06-17T00:00:00.000Z",
    })

    expect(changed).toBe(true)
    expect(hasRead(baseSqls)).toBe(true) // existence SELECT happened pre-tx
    expect(hasRead(txSqls)).toBe(false) // no read leaked into the buffered tx
    expect(txSqls.some((s) => /insert\s+into\s+community_roles/i.test(s))).toBe(true)
  })

  test("grant: existing active role short-circuits with no write tx", async () => {
    const { client, txSqls } = recordingClient({ role_assignment_id: "rol_existing" })
    const changed = await grantCommunityRoleOnClient(client, {
      communityId: "cmt_r",
      targetUserId: "usr_t",
      role: "moderator",
      grantedByUserId: "usr_a",
      now: "2026-06-17T00:00:00.000Z",
    })

    expect(changed).toBe(false)
    expect(txSqls.length).toBe(0)
  })

  test("revoke: changed reflects pre-tx read, tx is UPDATE-only", async () => {
    const { client, baseSqls, txSqls } = recordingClient({ role_assignment_id: "rol_existing" })
    const changed = await revokeCommunityRoleOnClient(client, {
      communityId: "cmt_r",
      targetUserId: "usr_t",
      role: "moderator",
      now: "2026-06-17T00:00:00.000Z",
    })

    expect(changed).toBe(true)
    expect(hasRead(baseSqls)).toBe(true)
    expect(hasRead(txSqls)).toBe(false)
    expect(txSqls.some((s) => /update\s+community_roles/i.test(s))).toBe(true)
    expect(txSqls.some((s) => /'revoked'/i.test(s))).toBe(true)
  })

  test("revoke: no active role short-circuits with no write tx", async () => {
    const { client, txSqls } = recordingClient(null)
    const changed = await revokeCommunityRoleOnClient(client, {
      communityId: "cmt_r",
      targetUserId: "usr_t",
      role: "moderator",
      now: "2026-06-17T00:00:00.000Z",
    })

    expect(changed).toBe(false)
    expect(txSqls.length).toBe(0)
  })
})
