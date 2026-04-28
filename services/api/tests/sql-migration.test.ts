import { describe, expect, test } from "bun:test"
import { splitSqlStatements, toSqliteCompatibleStatement, toSqliteCompatibleStatements } from "../shared/sql-migration"

describe("sql migration helpers", () => {
  test("keeps dollar-quoted DO blocks intact so they can be skipped later", () => {
    const sql = `
      CREATE TABLE example (id TEXT PRIMARY KEY);

      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'example_id_fkey'
        ) THEN
          ALTER TABLE example
            ADD CONSTRAINT example_id_fkey
            FOREIGN KEY (id) REFERENCES other(id);
        END IF;
      END $$;
    `

    expect(splitSqlStatements(sql)).toEqual([
      "CREATE TABLE example (id TEXT PRIMARY KEY);",
      `DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM information_schema.table_constraints
          WHERE constraint_name = 'example_id_fkey'
        ) THEN
          ALTER TABLE example
            ADD CONSTRAINT example_id_fkey
            FOREIGN KEY (id) REFERENCES other(id);
        END IF;
      END $$;`,
    ])
  })

  test("rewrites postgres defaults and skips DO blocks for sqlite", () => {
    expect(toSqliteCompatibleStatement(
      "CREATE TABLE linked_handles (created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());",
    )).toBe("CREATE TABLE linked_handles (created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);")

    expect(toSqliteCompatibleStatement(
      "ALTER TABLE verification_sessions ADD COLUMN verification_requirements_json JSONB NOT NULL DEFAULT '[]'::jsonb;",
    )).toBe("ALTER TABLE verification_sessions ADD COLUMN verification_requirements_json TEXT NOT NULL DEFAULT '[]';")

    expect(toSqliteCompatibleStatement("DO $$ BEGIN SELECT 1; END $$;")).toBeNull()
  })

  test("ignores comment-only migrations", () => {
    const sql = `
      -- Retired before runtime wiring.
      -- No schema changes remain.
    `

    expect(splitSqlStatements(sql)).toEqual([])
    expect(toSqliteCompatibleStatement(sql)).toBeNull()
  })

  test("expands namespace Spaces root label checks into sqlite triggers", () => {
    const statements = toSqliteCompatibleStatements(`
      ALTER TABLE namespace_verifications
        ADD CONSTRAINT namespace_verifications_spaces_root_label_ascii_check
        CHECK (
          family <> 'spaces'
          OR normalized_root_label ~ '^[a-z0-9-]+$'
        );
    `)

    expect(statements).toHaveLength(2)
    expect(statements[0]).toContain("BEFORE INSERT ON namespace_verifications")
    expect(statements[1]).toContain("BEFORE UPDATE OF family, normalized_root_label ON namespace_verifications")
  })
})
