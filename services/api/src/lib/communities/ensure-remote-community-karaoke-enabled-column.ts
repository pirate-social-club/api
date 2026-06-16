import type { Client } from "@libsql/client"
import { logPipelineInfo } from "../observability/pipeline-log"

const COMMUNITY_KARAOKE_ENABLED_MIGRATION_NAME = "1096_community_karaoke_enabled.sql"
const COMMUNITY_KARAOKE_ENABLED_MIGRATION_CHECKSUM = "d93d7ae6bdc91ac050a09db78b1922d7cc26f619d13616baffb47c4cd579f9a4"

type EnsureRemoteCommunityKaraokeEnabledColumnContext = {
  communityId?: string | null
}

async function getCommunityColumnNames(client: Client): Promise<Set<string>> {
  const result = await client.execute("PRAGMA table_info(communities)")
  return new Set(result.rows.map((row) => String(row.name)))
}

export async function ensureRemoteCommunityKaraokeEnabledColumn(
  client: Client,
  context: EnsureRemoteCommunityKaraokeEnabledColumnContext = {},
): Promise<void> {
  const columnNames = await getCommunityColumnNames(client)
  let addedColumn = false
  let duplicateColumnRace = false
  if (!columnNames.has("karaoke_enabled")) {
    try {
      await client.execute(`
        ALTER TABLE communities
          ADD COLUMN karaoke_enabled INTEGER NOT NULL DEFAULT 0 CHECK (karaoke_enabled IN (0, 1))
      `)
      addedColumn = true
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.toLowerCase().includes("duplicate column")) {
        throw error
      }
      duplicateColumnRace = true
    }
  }

  await client.batch([
    {
      sql: `
        CREATE TABLE IF NOT EXISTS schema_migrations (
          migration_name TEXT PRIMARY KEY,
          migration_label TEXT NOT NULL,
          checksum TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `,
      args: [],
    },
    {
      sql: `
        INSERT OR IGNORE INTO schema_migrations (migration_name, migration_label, checksum)
        VALUES (?1, 'community-template', ?2)
      `,
      args: [COMMUNITY_KARAOKE_ENABLED_MIGRATION_NAME, COMMUNITY_KARAOKE_ENABLED_MIGRATION_CHECKSUM],
    },
  ], "write")

  if (addedColumn || duplicateColumnRace) {
    logPipelineInfo("[community-db-factory] remote community db schema self-healed", {
      community_id: context.communityId ?? null,
      migration_name: COMMUNITY_KARAOKE_ENABLED_MIGRATION_NAME,
      table: "communities",
      column: "karaoke_enabled",
      added_column: addedColumn,
      duplicate_column_race: duplicateColumnRace,
    })
  }
}
