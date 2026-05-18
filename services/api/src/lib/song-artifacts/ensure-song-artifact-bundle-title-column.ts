import type { Client } from "../sql-client"
import { hasReadableSongArtifactBundleColumn, isDuplicateColumnError } from "./song-artifact-schema-heal"

const SONG_ARTIFACT_BUNDLE_TITLE_MIGRATION_NAME = "0080_control_plane_song_artifact_bundle_title.sql"
const SONG_ARTIFACT_BUNDLE_TITLE_MIGRATION_CHECKSUM = "5051c88bdbf9d3278d5e23c049f88a5594b101d9de1e976744a76dcc51c6797e"

const ensureTitleColumnPromises = new WeakMap<Client, Promise<void>>()

async function ensureTitleColumnOnce(client: Client): Promise<void> {
  if (await hasReadableSongArtifactBundleColumn(client, "title")) {
    return
  }

  try {
    await client.execute("ALTER TABLE song_artifact_bundles ADD COLUMN title TEXT")
  } catch (error) {
    if (!isDuplicateColumnError(error)) {
      throw error
    }
  }

  await client.batch([
    {
      sql: `
        UPDATE song_artifact_bundles
        SET title = 'Untitled track'
        WHERE title IS NULL
      `,
      args: [],
    },
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
        VALUES (?1, 'control-plane', ?2)
      `,
      args: [
        SONG_ARTIFACT_BUNDLE_TITLE_MIGRATION_NAME,
        SONG_ARTIFACT_BUNDLE_TITLE_MIGRATION_CHECKSUM,
      ],
    },
  ], "write")
}

export async function ensureSongArtifactBundleTitleColumn(client: Client): Promise<void> {
  const existing = ensureTitleColumnPromises.get(client)
  if (existing) {
    await existing
    return
  }

  const promise = ensureTitleColumnOnce(client).catch((error) => {
    ensureTitleColumnPromises.delete(client)
    throw error
  })
  ensureTitleColumnPromises.set(client, promise)
  await promise
}
