import type { Client } from "@libsql/client"

const SONG_ENGAGEMENT_ACTIVITY_TIMEZONE_MIGRATION_NAME = "1123_song_engagement_activity_timezone.sql"
const SONG_ENGAGEMENT_ACTIVITY_TIMEZONE_MIGRATION_CHECKSUM = "3116cf936ead054bebd67a1895741a88cec95e5f3f959e3c23ec984c8e82f100"

async function getSongEngagementDayColumnNames(client: Client): Promise<Set<string>> {
  const result = await client.execute("PRAGMA table_info(song_engagement_days)")
  return new Set(result.rows.map((row) => String(row.name)))
}

export async function ensureRemoteSongEngagementActivityTimezoneColumn(client: Client): Promise<void> {
  const columnNames = await getSongEngagementDayColumnNames(client)
  if (!columnNames.has("activity_timezone")) {
    try {
      await client.execute("ALTER TABLE song_engagement_days ADD COLUMN activity_timezone TEXT")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.toLowerCase().includes("duplicate column")) {
        throw error
      }
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
      args: [SONG_ENGAGEMENT_ACTIVITY_TIMEZONE_MIGRATION_NAME, SONG_ENGAGEMENT_ACTIVITY_TIMEZONE_MIGRATION_CHECKSUM],
    },
  ])
}
