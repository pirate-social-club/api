import type { Client } from "../sql-client"
import { hasReadableSongArtifactBundleColumn, isDuplicateColumnError } from "./song-artifact-schema-heal"

const SONG_ARTIFACT_BUNDLE_KARAOKE_REVISION_MIGRATION_NAME =
  "0129_control_plane_song_artifact_karaoke_revision.sql"
const SONG_ARTIFACT_BUNDLE_KARAOKE_REVISION_MIGRATION_CHECKSUM =
  "81ea2a26d5316225e20478fe4d23cfd684483448713ade0a5bada90eef593728"

const ensureKaraokeRevisionColumnPromises = new WeakMap<Client, Promise<void>>()

async function ensureKaraokeRevisionColumnOnce(client: Client): Promise<void> {
  if (await hasReadableSongArtifactBundleColumn(client, "karaoke_revision_id")) {
    return
  }

  try {
    await client.execute("ALTER TABLE song_artifact_bundles ADD COLUMN karaoke_revision_id TEXT")
  } catch (error) {
    if (!isDuplicateColumnError(error)) {
      throw error
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
        VALUES (?1, 'control-plane', ?2)
      `,
      args: [
        SONG_ARTIFACT_BUNDLE_KARAOKE_REVISION_MIGRATION_NAME,
        SONG_ARTIFACT_BUNDLE_KARAOKE_REVISION_MIGRATION_CHECKSUM,
      ],
    },
  ], "write")
}

export async function ensureSongArtifactBundleKaraokeRevisionColumn(client: Client): Promise<void> {
  const existing = ensureKaraokeRevisionColumnPromises.get(client)
  if (existing) {
    await existing
    return
  }

  const promise = ensureKaraokeRevisionColumnOnce(client).catch((error) => {
    ensureKaraokeRevisionColumnPromises.delete(client)
    throw error
  })
  ensureKaraokeRevisionColumnPromises.set(client, promise)
  await promise
}
