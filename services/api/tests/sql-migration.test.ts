import { describe, expect, test } from "bun:test"
import { splitSqlStatements, toSqliteCompatibleStatement } from "../shared/sql-migration"

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
})
