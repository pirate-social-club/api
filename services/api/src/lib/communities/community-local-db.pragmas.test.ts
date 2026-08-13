import { describe, expect, test } from "bun:test"
import { splitConnectionPragmas } from "./community-local-db"

describe("local community migration connection pragmas", () => {
  test("extracts a leading pragma after migration header comments", () => {
    const result = splitConnectionPragmas([
      "-- migration purpose\n-- rollout note\nPRAGMA foreign_keys = OFF;",
      "CREATE TABLE replacement (id TEXT PRIMARY KEY);",
      "PRAGMA foreign_keys = ON;",
    ])

    expect(result).toEqual({
      leadingPragmas: [{ name: "foreign_keys", sql: "PRAGMA foreign_keys = OFF" }],
      bodyStatements: ["CREATE TABLE replacement (id TEXT PRIMARY KEY);"],
      trailingPragmas: [{ name: "foreign_keys", sql: "PRAGMA foreign_keys = ON" }],
    })
  })

  test("extracts a pragma after mixed block and line comments", () => {
    const result = splitConnectionPragmas([
      "/* migration purpose */\n-- rollout note\nPRAGMA legacy_alter_table = 1;",
      "ALTER TABLE replacement RENAME TO canonical;",
    ])

    expect(result.leadingPragmas).toEqual([
      { name: "legacy_alter_table", sql: "PRAGMA legacy_alter_table = ON" },
    ])
    expect(result.bodyStatements).toEqual(["ALTER TABLE replacement RENAME TO canonical;"])
  })
})
