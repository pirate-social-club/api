import { describe, expect, test } from "bun:test"
import type { Client, InStatement, QueryResult, Transaction } from "../sql-client"
import {
  acquireHnsImportRestartAttempt,
  completeHnsImportRestartAttempt,
  releaseHnsImportRestartAttempt,
  releaseHnsImportSessionLock,
  reserveHnsImportSessionLock,
} from "./hns-import-session-lock"

class LockClient implements Client {
  statements: InStatement[] = []

  constructor(
    private readonly reserveRows: QueryResult["rows"],
    private readonly attemptRows: QueryResult["rows"] = [],
  ) {}

  async execute(statement: InStatement | string): Promise<QueryResult> {
    if (typeof statement === "string") throw new Error("expected structured SQL")
    this.statements.push(statement)
    if (statement.sql.includes("INSERT INTO hns_import_session_locks")) {
      return { rows: this.reserveRows, rowsAffected: this.reserveRows.length }
    }
    if (statement.sql.includes("SET restart_attempt_token = ?3")) {
      return { rows: this.attemptRows, rowsAffected: this.attemptRows.length }
    }
    return { rows: [], rowsAffected: 1 }
  }

  async batch(): Promise<QueryResult[]> {
    throw new Error("batch not implemented")
  }

  async transaction(): Promise<Transaction> {
    throw new Error("transaction not implemented")
  }
}

const input = {
  normalizedRootLabel: "clawitzer",
  sessionId: "nvs_one",
  userId: "usr_one",
  expiresAt: "2026-08-07T00:00:00.000Z",
  now: "2026-08-06T00:00:00.000Z",
}

describe("HNS import session lock", () => {
  test("atomically reserves an unclaimed or expired root", async () => {
    const client = new LockClient([{ namespace_verification_session_id: "nvs_one" }])
    await reserveHnsImportSessionLock(client, input)

    expect(client.statements[0]?.sql).toContain("ON CONFLICT (normalized_root_label) DO UPDATE")
    expect(client.statements[0]?.sql).toContain("WHERE hns_import_session_locks.expires_at <= ?5")
    expect(client.statements[0]?.sql).toContain("namespace_verification_session_id = ?2")
    expect(client.statements[0]?.args).toEqual([
      "clawitzer",
      "nvs_one",
      "usr_one",
      "2026-08-07T00:00:00.000Z",
      "2026-08-06T00:00:00.000Z",
    ])
  })

  test("atomically renews the lock when the same session restarts", async () => {
    const client = new LockClient([{ namespace_verification_session_id: "nvs_one" }])
    await reserveHnsImportSessionLock(client, input)

    expect(client.statements[0]?.sql).toContain(
      "OR hns_import_session_locks.namespace_verification_session_id = ?2",
    )
    expect(client.statements[0]?.sql).toContain(
      "THEN hns_import_session_locks.expires_at",
    )
  })

  test("rejects a second active session for the same root", async () => {
    const client = new LockClient([])
    await expect(reserveHnsImportSessionLock(client, input)).rejects.toMatchObject({
      status: 409,
      code: "conflict",
      details: { root_label: "clawitzer" },
    })
  })

  test("only releases the matching session lease", async () => {
    const client = new LockClient([])
    await releaseHnsImportSessionLock(client, {
      normalizedRootLabel: "clawitzer",
      sessionId: "nvs_one",
    })

    expect(client.statements[0]?.sql).toContain("namespace_verification_session_id = ?2")
    expect(client.statements[0]?.args).toEqual(["clawitzer", "nvs_one"])
  })

  test("fences restart attempts and reuses the durable challenge after lease expiry", async () => {
    const client = new LockClient([], [{
      restart_attempt_token: "hra_two",
      restart_challenge_txt_value: "pirate-verification=nch_one",
    }])
    const attempt = await acquireHnsImportRestartAttempt(client, {
      normalizedRootLabel: "clawitzer",
      sessionId: "nvs_one",
      token: "hra_two",
      challengeTxtValue: "pirate-verification=nch_two",
      expiresAt: "2026-08-06T00:10:00.000Z",
      now: "2026-08-06T00:00:00.000Z",
    })

    expect(attempt).toEqual({
      token: "hra_two",
      challengeTxtValue: "pirate-verification=nch_one",
    })
    expect(client.statements[0]?.sql).toContain(
      "restart_challenge_txt_value = COALESCE(restart_challenge_txt_value, ?4)",
    )
    expect(client.statements[0]?.sql).toContain("restart_attempt_expires_at <= ?6")
  })

  test("releases only the matching restart attempt token", async () => {
    const client = new LockClient([])
    await releaseHnsImportRestartAttempt(client, {
      normalizedRootLabel: "clawitzer",
      sessionId: "nvs_one",
      token: "hra_one",
    })

    expect(client.statements[0]?.sql).toContain("restart_attempt_token = ?3")
    expect(client.statements[0]?.args).toEqual(["clawitzer", "nvs_one", "hra_one"])
  })

  test("finalizes only an owned restart attempt and advances the session lease", async () => {
    class FinalizeClient extends LockClient {
      override async execute(statement: InStatement | string): Promise<QueryResult> {
        const result = await super.execute(statement)
        return { ...result, rowsAffected: 1 }
      }
    }
    const client = new FinalizeClient([])
    await completeHnsImportRestartAttempt(client, {
      normalizedRootLabel: "clawitzer",
      sessionId: "nvs_one",
      token: "hra_one",
      sessionExpiresAt: "2026-08-07T00:00:00.000Z",
    })

    expect(client.statements[0]?.sql).toContain("expires_at = ?4")
    expect(client.statements[0]?.sql).toContain("restart_attempt_token = ?3")
    expect(client.statements[0]?.args).toEqual([
      "clawitzer",
      "nvs_one",
      "hra_one",
      "2026-08-07T00:00:00.000Z",
    ])
  })

  test("rejects finalization after attempt ownership is lost", async () => {
    class LostAttemptClient extends LockClient {
      override async execute(statement: InStatement | string): Promise<QueryResult> {
        await super.execute(statement)
        return { rows: [], rowsAffected: 0 }
      }
    }
    const client = new LostAttemptClient([])
    await expect(completeHnsImportRestartAttempt(client, {
      normalizedRootLabel: "clawitzer",
      sessionId: "nvs_one",
      token: "hra_stale",
      sessionExpiresAt: "2026-08-07T00:00:00.000Z",
    })).rejects.toMatchObject({ status: 409, code: "conflict" })
  })
})
