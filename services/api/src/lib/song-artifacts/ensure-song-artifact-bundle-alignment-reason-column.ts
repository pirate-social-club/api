import type { Client } from "../sql-client"
import { hasReadableSongArtifactBundleColumn, isDuplicateColumnError } from "./song-artifact-schema-heal"

const SONG_ARTIFACT_BUNDLE_ALIGNMENT_REASON_MIGRATION_NAME = "0128_control_plane_song_artifact_alignment_reason.sql"
const SONG_ARTIFACT_BUNDLE_ALIGNMENT_REASON_MIGRATION_CHECKSUM = "4a4d027f1a60342855fff6e20df2da0d299cd42393dc1d46f2d0123c043a48c3"

const ensureAlignmentReasonColumnPromises = new WeakMap<Client, Promise<void>>()

async function ensureAlignmentReasonColumnOnce(client: Client): Promise<void> {
  if (await hasReadableSongArtifactBundleColumn(client, "alignment_reason")) {
    return
  }

  try {
    await client.execute("ALTER TABLE song_artifact_bundles ADD COLUMN alignment_reason TEXT")
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
        SONG_ARTIFACT_BUNDLE_ALIGNMENT_REASON_MIGRATION_NAME,
        SONG_ARTIFACT_BUNDLE_ALIGNMENT_REASON_MIGRATION_CHECKSUM,
      ],
    },
  ], "write")
}

export async function ensureSongArtifactBundleAlignmentReasonColumn(client: Client): Promise<void> {
  const existing = ensureAlignmentReasonColumnPromises.get(client)
  if (existing) {
    await existing
    return
  }

  const promise = ensureAlignmentReasonColumnOnce(client).catch((error) => {
    ensureAlignmentReasonColumnPromises.delete(client)
    throw error
  })
  ensureAlignmentReasonColumnPromises.set(client, promise)
  await promise
}
