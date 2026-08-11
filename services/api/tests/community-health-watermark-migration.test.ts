import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

import { splitSqlStatements, toSqliteCompatibleStatements } from "../shared/sql-migration"

async function applyControlPlaneFixture(database: Database, migrationName: string): Promise<void> {
  const sql = await readFile(resolve(
    import.meta.dir,
    "../test-fixtures/db/control-plane/migrations",
    migrationName,
  ), "utf8")
  for (const statement of splitSqlStatements(sql).flatMap(toSqliteCompatibleStatements)) {
    database.exec(statement)
  }
}

describe("0214_control_plane_community_health_sync_watermark.sql", () => {
  test("seeds a runtime-owned cutover handshake without mutating the old runtime projection", async () => {
    const database = new Database(":memory:")
    try {
      await applyControlPlaneFixture(database, "0079_control_plane_community_health_counts.sql")
      database.run(
        "INSERT INTO community_health_counts (community_id, total_views, updated_at) VALUES (?, ?, ?)",
        ["cmt_old_projection", 123, "2026-08-10T00:00:00.000Z"],
      )

      await applyControlPlaneFixture(database, "0214_control_plane_community_health_sync_watermark.sql")

      expect(database.query("SELECT community_id, total_views FROM community_health_counts").all()).toEqual([{
        community_id: "cmt_old_projection",
        total_views: 123,
      }])
      expect(database.query(`
        SELECT projection_key, next_date = CURRENT_DATE AS starts_today, reset_required
        FROM community_health_sync_state
      `).all()).toEqual([{
        projection_key: "tinybird_community_health_daily",
        starts_today: 1,
        reset_required: 1,
      }])
    } finally {
      database.close()
    }
  })
})
