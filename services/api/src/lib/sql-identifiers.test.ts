import { describe, expect, test } from "bun:test"
import { sqlIdentifier } from "./sql-identifiers"

describe("sqlIdentifier", () => {
  test("accepts simple lowercase SQL identifiers", () => {
    expect(sqlIdentifier("profiles")).toBe("profiles")
    expect(sqlIdentifier("xmtp_inbox_id")).toBe("xmtp_inbox_id")
    expect(sqlIdentifier("notification_events2")).toBe("notification_events2")
  })

  test("rejects unsafe SQL identifier text", () => {
    expect(() => sqlIdentifier("Profiles")).toThrow("invalid SQL identifier")
    expect(() => sqlIdentifier("profile-id")).toThrow("invalid SQL identifier")
    expect(() => sqlIdentifier("profiles; DROP TABLE users")).toThrow("invalid SQL identifier")
    expect(() => sqlIdentifier("1profile")).toThrow("invalid SQL identifier")
  })
})
