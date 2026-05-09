import { afterEach, describe, expect, test } from "bun:test"
import { createControlPlaneTestClient } from "./helpers"
import { ensureSongArtifactBundleTitleColumn } from "../src/lib/song-artifacts/ensure-song-artifact-bundle-title-column"

const cleanupTasks: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanupTasks.splice(0).map((cleanup) => cleanup()))
})

async function listColumns(client: Awaited<ReturnType<typeof createControlPlaneTestClient>>["client"]): Promise<string[]> {
  const result = await client.execute("PRAGMA table_info(song_artifact_bundles)")
  return result.rows.map((row) => String(row.name))
}

describe("ensureSongArtifactBundleTitleColumn", () => {
  test("adds the title column to a baseline control-plane database", async () => {
    const setup = await createControlPlaneTestClient()
    cleanupTasks.push(setup.cleanup)

    await setup.client.execute({
      sql: `
        INSERT INTO users (
          user_id, verification_state, verification_capabilities_json, created_at, updated_at
        ) VALUES (
          'user_title_heal', 'verified', '{}', ?1, ?1
        )
      `,
      args: ["2026-05-09T00:00:00.000Z"],
    })
    await setup.client.execute({
      sql: `
        INSERT INTO communities (
          community_id, creator_user_id, display_name, membership_mode, status,
          provisioning_state, transfer_state, created_at, updated_at
        ) VALUES (
          'comm_title_heal', 'user_title_heal', 'Title Heal', 'open', 'active',
          'active', 'none', ?1, ?1
        )
      `,
      args: ["2026-05-09T00:00:00.000Z"],
    })
    await setup.client.execute({
      sql: `
        INSERT INTO song_artifact_bundles (
          song_artifact_bundle_id, community_id, creator_user_id, status, primary_audio_json,
          lyrics_text, lyrics_sha256, created_at, updated_at
        ) VALUES (
          'bundle_title_heal', 'comm_title_heal', 'user_title_heal', 'ready', '{}',
          'lyrics', 'sha256', ?1, ?1
        )
      `,
      args: ["2026-05-09T00:00:00.000Z"],
    })

    expect(await listColumns(setup.client)).not.toContain("title")

    await ensureSongArtifactBundleTitleColumn(setup.client)
    await ensureSongArtifactBundleTitleColumn(setup.client)

    expect(await listColumns(setup.client)).toContain("title")

    const bundle = await setup.client.execute({
      sql: "SELECT title FROM song_artifact_bundles WHERE song_artifact_bundle_id = ?1",
      args: ["bundle_title_heal"],
    })
    expect(bundle.rows[0]?.title).toBe("Untitled track")

    const migration = await setup.client.execute({
      sql: "SELECT checksum FROM schema_migrations WHERE migration_name = ?1 LIMIT 1",
      args: ["0080_control_plane_song_artifact_bundle_title.sql"],
    })
    expect(migration.rows[0]?.checksum).toBe(
      "5051c88bdbf9d3278d5e23c049f88a5594b101d9de1e976744a76dcc51c6797e",
    )
  })
})
