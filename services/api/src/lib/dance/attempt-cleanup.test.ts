import { describe, expect, test } from "bun:test"

import { cleanupDueDanceAttempts } from "./attempt-cleanup"
import { danceAttemptPlaceholderObjectKey } from "./attempt-object-key"

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
    expect(expiry?.replace(/\s+/g, " ")).toContain(
      danceAttemptPlaceholderObjectKey("SESSION_ID").replace(
        "SESSION_ID",
        "' || dance_attempt_session_id || '",
      ),
    )
  })

  test("claims and deletes cancelled media through the real cleanup path", async () => {
    const sessionId = "dse_cancelled"
    const objectKey = `dance/attempt-media/${sessionId}/${"a".repeat(64)}.mp4`
    let cleanupStatus = "pending"
    let claimReturned = false
    let deletedObject = false

    const outerExecute = async (query: string | { sql: string; args?: unknown[] }) => {
      const sql = typeof query === "string" ? query : query.sql
      const args = typeof query === "string" ? [] : query.args ?? []
      if (sql.includes("DELETE FROM dance_attempt_fingerprints")) {
        return { rows: [], rowsAffected: 0 }
      }
      if (sql.includes("SET status = 'expired'")) {
        return { rows: [], rowsAffected: 0 }
      }
      if (sql.includes("SET cleanup_status = 'deleted'")) {
        expect(args[0]).toBe(sessionId)
        expect(cleanupStatus).toBe("retrying")
        cleanupStatus = "deleted"
        return { rows: [], rowsAffected: 1 }
      }
      throw new Error(`unexpected outer SQL: ${sql}`)
    }
    const transaction = async () => ({
      execute: async (query: string | { sql: string; args?: unknown[] }) => {
        const sql = typeof query === "string" ? query : query.sql
        if (sql.includes("SELECT dance_attempt_session_id")) {
          if (claimReturned || cleanupStatus !== "pending") {
            return { rows: [], rowsAffected: 0 }
          }
          claimReturned = true
          return {
            rows: [{
              dance_attempt_session_id: sessionId,
              upload_object_key: objectKey,
              cleanup_attempt_count: 0,
            }],
            rowsAffected: 1,
          }
        }
        if (sql.includes("SET cleanup_status = 'retrying'")) {
          expect(cleanupStatus).toBe("pending")
          cleanupStatus = "retrying"
          return { rows: [], rowsAffected: 1 }
        }
        throw new Error(`unexpected transaction SQL: ${sql}`)
      },
      commit: async () => {},
      rollback: async () => {},
      close: () => {},
    })

    const summary = await cleanupDueDanceAttempts({
      env: {
        DANCE_ATTEMPT_S3_ENDPOINT: "https://storage.example.test",
        DANCE_ATTEMPT_S3_ACCESS_KEY: "test-access-key",
        DANCE_ATTEMPT_S3_SECRET_KEY: "test-secret-key", // gitleaks:allow — test-only signing input.
        DANCE_ATTEMPT_S3_BUCKET: "dance-attempts",
        DANCE_ATTEMPT_S3_REGION: "auto",
      } as never,
      client: { execute: outerExecute, transaction } as never,
      fetchFn: async (request) => {
        const signedRequest = request as Request
        expect(signedRequest.method).toBe("DELETE")
        expect(signedRequest.url).toContain(objectKey)
        deletedObject = true
        return new Response(null, { status: 204 })
      },
      now: () => Date.parse("2026-07-30T00:00:00.000Z"),
    })

    expect(deletedObject).toBe(true)
    expect(cleanupStatus).toBe("deleted")
    expect(summary).toEqual({
      expired: 0,
      expired_fingerprints: 0,
      claimed: 1,
      deleted: 1,
      retry_scheduled: 0,
      failed: 0,
    })
  })
})
