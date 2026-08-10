import { describe, expect, test } from "bun:test"

import { cleanupDueDanceAttempts } from "./attempt-cleanup"

describe("dance attempt cleanup", () => {
  test("claims only terminal sessions so grading media cannot be deleted", async () => {
    const statements: string[] = []
    const execute = async (query: string | { sql: string }) => {
      const sql = typeof query === "string" ? query : query.sql
      statements.push(sql)
      return { rows: [], rowsAffected: 0 }
    }
    const transaction = async () => ({
      execute,
      commit: async () => {},
      rollback: async () => {},
      close: () => {},
    })
    const summary = await cleanupDueDanceAttempts({
      env: {} as never,
      client: { execute, transaction } as never,
      now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    })
    expect(summary).toEqual({
      expired: 0,
      expired_fingerprints: 0,
      claimed: 0,
      deleted: 0,
      retry_scheduled: 0,
      failed: 0,
    })
    const claim = statements.find((sql) =>
      sql.includes("FROM dance_attempt_sessions")
    )
    expect(claim).toContain(
      "status IN ('finalized', 'rejected', 'failed', 'expired', 'cancelled')",
    )
    const expiry = statements.find((sql) =>
      sql.includes("SET status = 'expired'")
    )
    expect(expiry).toContain("THEN 'not_required'")
    expect(expiry).toContain("THEN NULL")
  })
})
