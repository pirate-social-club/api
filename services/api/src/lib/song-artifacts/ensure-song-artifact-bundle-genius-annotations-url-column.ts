import type { Client } from "../sql-client"
import { hasReadableSongArtifactBundleColumn, isDuplicateColumnError } from "./song-artifact-schema-heal"

const SONG_ARTIFACT_BUNDLE_GENIUS_ANNOTATIONS_URL_MIGRATION_NAME =
  "0096_control_plane_song_artifact_bundle_genius_annotations_url.sql"
const SONG_ARTIFACT_BUNDLE_GENIUS_ANNOTATIONS_URL_MIGRATION_CHECKSUM =
  "a2630c67b0c7dd722e925bd7162659feeb4d4c611521f46ade94e177eb5b5a6f"

const ensureGeniusAnnotationsUrlColumnPromises = new WeakMap<Client, Promise<void>>()

async function ensureGeniusAnnotationsUrlColumnOnce(client: Client): Promise<void> {
  if (await hasReadableSongArtifactBundleColumn(client, "genius_annotations_url")) {
    return
  }

  try {
    await client.execute("ALTER TABLE song_artifact_bundles ADD COLUMN genius_annotations_url TEXT")
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
        SONG_ARTIFACT_BUNDLE_GENIUS_ANNOTATIONS_URL_MIGRATION_NAME,
        SONG_ARTIFACT_BUNDLE_GENIUS_ANNOTATIONS_URL_MIGRATION_CHECKSUM,
      ],
    },
  ], "write")
}

export async function ensureSongArtifactBundleGeniusAnnotationsUrlColumn(client: Client): Promise<void> {
  const existing = ensureGeniusAnnotationsUrlColumnPromises.get(client)
  if (existing) {
    await existing
    return
  }

  const promise = ensureGeniusAnnotationsUrlColumnOnce(client).catch((error) => {
    ensureGeniusAnnotationsUrlColumnPromises.delete(client)
    throw error
  })
  ensureGeniusAnnotationsUrlColumnPromises.set(client, promise)
  await promise
}
