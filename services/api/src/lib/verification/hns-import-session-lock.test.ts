import { describe, expect, test } from "bun:test"
import type { Client, InStatement, QueryResult, Transaction } from "../sql-client"
import {
  releaseHnsImportSessionLock,
  reserveHnsImportSessionLock,
} from "./hns-import-session-lock"

class LockClient implements Client {
  statements: InStatement[] = []

  constructor(private readonly reserveRows: QueryResult["rows"]) {}

  async execute(statement: InStatement | string): Promise<QueryResult> {
    if (typeof statement === "string") throw new Error("expected structured SQL")
    this.statements.push(statement)
    if (statement.sql.includes("INSERT INTO hns_import_session_locks")) {
      return { rows: this.reserveRows, rowsAffected: this.reserveRows.length }
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
    expect(client.statements[0]?.args).toEqual([
      "clawitzer",
      "nvs_one",
      "usr_one",
      "2026-08-07T00:00:00.000Z",
      "2026-08-06T00:00:00.000Z",
    ])
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
})
