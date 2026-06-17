import { describe, expect, test } from "bun:test"
import { applyCommunityGateUpdateOnClient } from "./community-gate-settings-service"
import type { Client } from "../sql-client"
import type { UpdateCommunityGatesRequestBody } from "./create/update-validation"

/**
 * Buffer-safety regression for the gate update write path. Under the D1 buffering
 * client a SELECT issued INSIDE a write tx sees nothing until commit, so the current
 * access + gate-policy reads must run on the base client BEFORE the tx and the tx
 * body must be write-only. The recording client records base-client statements
 * separately from in-tx statements; the test fails if a read leaks into the tx.
 */
function recordingClient() {
  const baseSqls: string[] = []
  const txSqls: string[] = []
  const client = {
    execute: async (statement: { sql: string } | string) => {
      baseSqls.push(typeof statement === "string" ? statement : statement.sql)
      return { rows: [] }
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

const baseBody = {
  membership_mode: "open",
  default_age_gate_policy: "none",
  allow_anonymous_identity: false,
  anonymous_identity_scope: null,
  gate_policy: null,
} as unknown as UpdateCommunityGatesRequestBody

describe("applyCommunityGateUpdateOnClient (buffer-safe)", () => {
  test("reads run pre-tx; tx body is write-only (UPDATE + DELETE)", async () => {
    const { client, baseSqls, txSqls } = recordingClient()
    const result = await applyCommunityGateUpdateOnClient(client, {
      communityId: "cmt_g",
      body: baseBody,
      now: "2026-06-17T00:00:00.000Z",
    })

    expect(result).toEqual({ previousAccess: null, previousGatePolicy: null })
    // Both existence reads ran on the base client, before the tx.
    expect(baseSqls.filter((s) => /^\s*select\b/i.test(s)).length).toBe(2)
    // No read leaked into the buffered tx.
    expect(hasRead(txSqls)).toBe(false)
    expect(txSqls.some((s) => /update\s+communities/i.test(s))).toBe(true)
    expect(txSqls.some((s) => /delete\s+from\s+community_gate_policies/i.test(s))).toBe(true)
    // No gate policy provided → no INSERT.
    expect(txSqls.some((s) => /insert\s+into\s+community_gate_policies/i.test(s))).toBe(false)
  })

  test("gate policy present → tx also INSERTs, still no in-tx read", async () => {
    const { client, txSqls } = recordingClient()
    const body = {
      ...baseBody,
      gate_policy: { version: 1, expression: { type: "always" } },
    } as unknown as UpdateCommunityGatesRequestBody

    await applyCommunityGateUpdateOnClient(client, {
      communityId: "cmt_g",
      body,
      now: "2026-06-17T00:00:00.000Z",
    })

    expect(hasRead(txSqls)).toBe(false)
    expect(txSqls.some((s) => /insert\s+into\s+community_gate_policies/i.test(s))).toBe(true)
  })
})
