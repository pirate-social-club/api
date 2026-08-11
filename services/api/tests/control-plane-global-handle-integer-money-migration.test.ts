import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import { splitSqlStatements, toSqliteCompatibleStatements } from "../shared/sql-migration"
import { createControlPlaneTestClient } from "./helpers"

const MIGRATION_NAME = "0213_control_plane_global_handle_integer_money.sql"

describe(MIGRATION_NAME, () => {
  test("converts paid global handles from floating-point USD to integer cents", async () => {
    const setup = await createControlPlaneTestClient()
    try {
      const now = "2026-08-11T00:00:00.000Z"
      await setup.client.execute({
        sql: `
          INSERT INTO users (
            user_id, verification_state, verification_capabilities_json, created_at, updated_at
          ) VALUES (?1, 'unverified', '{}', ?2, ?2)
        `,
        args: ["usr_integer_handle", now],
      })
      await setup.client.execute({
        sql: `
          INSERT INTO global_handles (
            global_handle_id, user_id, label_normalized, label_display, status, tier,
            issuance_source, price_paid_usd, free_rename_consumed, issued_at, created_at, updated_at
          ) VALUES (
            ?1, ?2, 'integer-handle', 'integer-handle', 'active', 'premium',
            'paid_upgrade', 12.34, 1, ?3, ?3, ?3
          )
        `,
        args: ["ghd_integer_handle", "usr_integer_handle", now],
      })

      const migrationPath = fileURLToPath(new URL(
        `../test-fixtures/db/control-plane/migrations/${MIGRATION_NAME}`,
        import.meta.url,
      ))
      const migrationSql = await readFile(migrationPath, "utf8")
      for (const statement of splitSqlStatements(migrationSql).flatMap(toSqliteCompatibleStatements)) {
        await setup.client.execute(statement)
      }

      const result = await setup.client.execute(
        "SELECT price_paid_cents FROM global_handles WHERE global_handle_id = 'ghd_integer_handle'",
      )
      expect(result.rows).toEqual([{ price_paid_cents: 1234 }])

      const columns = await setup.client.execute("PRAGMA table_info(global_handles)")
      expect(columns.rows.find((row) => row.name === "price_paid_cents")?.type).toBe("INTEGER")
      expect(columns.rows.some((row) => row.name === "price_paid_usd")).toBe(false)
    } finally {
      await setup.cleanup()
    }
  })
})
