import type { Client } from "@libsql/client"

const POST_SONG_TITLE_MIGRATION_NAME = "1069_post_song_title.sql"
const POST_SONG_TITLE_MIGRATION_CHECKSUM = "03a5f95f8fe4bec0492dd6d7a2c4c2d7d9e4df7e0af244dcd58cae869cb9e802"
const POST_SONG_PRESENTATION_MIGRATION_NAME = "1075_post_song_presentation.sql"
const POST_SONG_PRESENTATION_MIGRATION_CHECKSUM = "46da9ddcae0b2c5328a943d36dbb819d476e84dc4a5b7ffc5cc1268835b06368"
const POST_SONG_ANNOTATIONS_URL_MIGRATION_NAME = "1081_post_song_annotations_url.sql"
const POST_SONG_ANNOTATIONS_URL_MIGRATION_CHECKSUM = "4ffa5faa01551ecf40fdcdfdb8a4a892e359110b17d077c287fbc91584718b7b"

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
  if (!columnNames.has("song_cover_art_ref")) {
    try {
      await client.execute("ALTER TABLE posts ADD COLUMN song_cover_art_ref TEXT")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.toLowerCase().includes("duplicate column")) {
        throw error
      }
    }
  }
  if (!columnNames.has("song_duration_ms")) {
    try {
      await client.execute("ALTER TABLE posts ADD COLUMN song_duration_ms INTEGER")
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.toLowerCase().includes("duplicate column")) {
        throw error
      }
    }
  }
  if (!columnNames.has("song_annotations_url")) {
    try {
      await client.execute("ALTER TABLE posts ADD COLUMN song_annotations_url TEXT")
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
    {
      sql: `
        INSERT OR IGNORE INTO schema_migrations (migration_name, migration_label, checksum)
        VALUES (?1, 'community-template', ?2)
      `,
      args: [POST_SONG_PRESENTATION_MIGRATION_NAME, POST_SONG_PRESENTATION_MIGRATION_CHECKSUM],
    },
    {
      sql: `
        INSERT OR IGNORE INTO schema_migrations (migration_name, migration_label, checksum)
        VALUES (?1, 'community-template', ?2)
      `,
      args: [POST_SONG_ANNOTATIONS_URL_MIGRATION_NAME, POST_SONG_ANNOTATIONS_URL_MIGRATION_CHECKSUM],
    },
  ], "write")
}
