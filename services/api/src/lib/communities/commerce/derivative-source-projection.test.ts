import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createClient } from "@libsql/client"
import type { Env } from "../../../env"
import { findStoryRegisteredAssetProjectionSources } from "./derivative-source-projection"

const cleanupPaths: string[] = []

afterEach(async () => {
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe("findStoryRegisteredAssetProjectionSources", () => {
  test("orders duplicate Story references deterministically", async () => {
    const root = await mkdtemp(join(tmpdir(), "story-projection-order-"))
    cleanupPaths.push(root)
    const databaseUrl = `file:${join(root, "control-plane.db")}`
    const client = createClient({ url: databaseUrl })
    try {
      await client.execute(`
        CREATE TABLE story_registered_asset_projections (
          projection_id TEXT PRIMARY KEY,
          asset_id TEXT NOT NULL,
          community_id TEXT NOT NULL,
          source_post_id TEXT NOT NULL,
          display_title TEXT,
          creator_user_id TEXT NOT NULL,
          asset_kind TEXT NOT NULL,
          license_preset TEXT,
          commercial_rev_share_pct INTEGER,
          story_ip_id TEXT NOT NULL,
          story_license_terms_id TEXT NOT NULL,
          source_post_status TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `)
      await client.batch([
        {
          sql: `
            INSERT INTO story_registered_asset_projections (
              projection_id, asset_id, community_id, source_post_id, display_title,
              creator_user_id, asset_kind, license_preset, commercial_rev_share_pct,
              story_ip_id, story_license_terms_id, source_post_status, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'song_audio', 'commercial-remix', 10, ?7, ?8, 'published', ?9, ?9)
          `,
          args: [
            "projection_later",
            "asset_later",
            "community_later",
            "post_later",
            "Later projection",
            "user_later",
            "0xStory",
            "terms-1",
            "2026-01-02T00:00:00.000Z",
          ],
        },
        {
          sql: `
            INSERT INTO story_registered_asset_projections (
              projection_id, asset_id, community_id, source_post_id, display_title,
              creator_user_id, asset_kind, license_preset, commercial_rev_share_pct,
              story_ip_id, story_license_terms_id, source_post_status, created_at, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'song_audio', 'commercial-remix', 10, ?7, ?8, 'published', ?9, ?9)
          `,
          args: [
            "projection_earlier",
            "asset_earlier",
            "community_earlier",
            "post_earlier",
            "Earlier projection",
            "user_earlier",
            "0xStory",
            "terms-1",
            "2026-01-01T00:00:00.000Z",
          ],
        },
      ])
    } finally {
      client.close()
    }

    const rows = await findStoryRegisteredAssetProjectionSources({
      env: { CONTROL_PLANE_DATABASE_URL: databaseUrl } as Env,
      refs: [{ storyIp: "0xstory", licenseTermsId: "terms-1" }],
    })

    expect(rows.map((row) => row.asset_id)).toEqual(["asset_earlier", "asset_later"])
  })
})
