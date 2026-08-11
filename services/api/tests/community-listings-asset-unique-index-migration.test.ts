import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createClient } from "@libsql/client"

import { splitSqlStatements, toSqliteCompatibleStatements } from "../shared/sql-migration"

const migrationPath = fileURLToPath(new URL(
  "../test-fixtures/db/community-template/migrations/1155_listings_asset_unique_index.sql",
  import.meta.url,
))

async function applyMigration(client: ReturnType<typeof createClient>): Promise<void> {
  const sql = await readFile(migrationPath, "utf8")
  for (const statement of splitSqlStatements(sql).flatMap(toSqliteCompatibleStatements)) {
    await client.execute(statement)
  }
}

async function createListingsTable(client: ReturnType<typeof createClient>): Promise<void> {
  await client.execute(`
    CREATE TABLE listings (
      listing_id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      asset_id TEXT,
      live_room_id TEXT,
      replay_asset_id TEXT
    )
  `)
  await client.execute("CREATE INDEX idx_listings_asset ON listings(asset_id) WHERE asset_id IS NOT NULL")
}

describe("1155_listings_asset_unique_index.sql", () => {
  test("fails closed on pre-existing duplicate money records", async () => {
    const client = createClient({ url: ":memory:" })
    try {
      await createListingsTable(client)
      await client.execute({
        sql: "INSERT INTO listings (listing_id, community_id, asset_id) VALUES (?1, ?2, ?3), (?4, ?2, ?3)",
        args: ["lst_1", "cmt_1", "ast_1", "lst_2"],
      })

      await expect(applyMigration(client)).rejects.toThrow()
      const indexes = await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'listings' ORDER BY name",
      )
      const names = indexes.rows.map((row) => String(row.name))
      expect(names).toContain("idx_listings_asset")
      expect(names).not.toContain("idx_listings_community_asset_unique")
    } finally {
      client.close()
    }
  })

  test("enforces one asset listing per community while preserving cross-community and null subjects", async () => {
    const client = createClient({ url: ":memory:" })
    try {
      await createListingsTable(client)
      await client.execute({
        sql: "INSERT INTO listings (listing_id, community_id, asset_id) VALUES (?1, ?2, ?3)",
        args: ["lst_1", "cmt_1", "ast_1"],
      })
      await applyMigration(client)

      await expect(client.execute({
        sql: "INSERT INTO listings (listing_id, community_id, asset_id) VALUES (?1, ?2, ?3)",
        args: ["lst_duplicate", "cmt_1", "ast_1"],
      })).rejects.toThrow()

      await client.execute({
        sql: "INSERT INTO listings (listing_id, community_id, asset_id) VALUES (?1, ?2, ?3)",
        args: ["lst_other_community", "cmt_2", "ast_1"],
      })
      await client.execute({
        sql: "INSERT INTO listings (listing_id, community_id, live_room_id) VALUES (?1, ?2, ?3)",
        args: ["lst_live_1", "cmt_1", "room_1"],
      })
      await client.execute({
        sql: "INSERT INTO listings (listing_id, community_id, live_room_id) VALUES (?1, ?2, ?3)",
        args: ["lst_live_2", "cmt_1", "room_2"],
      })
    } finally {
      client.close()
    }
  })
})
