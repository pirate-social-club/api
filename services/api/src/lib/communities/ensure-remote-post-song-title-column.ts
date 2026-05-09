import type { Client } from "@libsql/client"

const POST_SONG_TITLE_MIGRATION_NAME = "1069_post_song_title.sql"
const POST_SONG_TITLE_MIGRATION_CHECKSUM = "03a5f95f8fe4bec0492dd6d7a2c4c2d7d9e4df7e0af244dcd58cae869cb9e802"

async function getPostColumnNames(client: Client): Promise<Set<string>> {
  const result = await client.execute("PRAGMA table_info(posts)")
  return new Set(result.rows.map((row) => String(row.name)))
}

export async function ensureRemotePostSongTitleColumn(client: Client): Promise<void> {
  const columnNames = await getPostColumnNames(client)
  if (!columnNames.has("song_title")) {
    try {
      await client.execute("ALTER TABLE posts ADD COLUMN song_title TEXT")
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
      args: [POST_SONG_TITLE_MIGRATION_NAME, POST_SONG_TITLE_MIGRATION_CHECKSUM],
    },
  ], "write")
}
