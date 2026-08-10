import { describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CommunityPostProjectionRow } from "../auth/auth-db-rows"
import type { Client } from "../sql-client"
import {
  hasPublicSongArtifactGrant,
  projectedPublicSongArtifactUploadIds,
  syncPublicSongArtifactGrantsForProjection,
} from "./public-song-artifact-grant-repository"

function projection(overrides: Partial<CommunityPostProjectionRow> = {}): CommunityPostProjectionRow {
  return {
    author_user_id: "usr_author",
    comment_count: 0,
    community_id: "cmt_music",
    created_at: "2026-08-10T00:00:00.000Z",
    downvote_count: 0,
    identity_mode: "public",
    like_count: 0,
    post_type: "video",
    projected_payload_json: JSON.stringify({
      access_mode: "public",
      media_refs: [{
        storage_ref: "https://api.pirate.sc/public-communities/com_cmt_music/song-artifact-uploads/sau_sau_video/content",
      }],
    }),
    projection_id: "cpp_video",
    projection_version: 1,
    source_created_at: "2026-08-10T00:00:00.000Z",
    source_post_id: "pst_video",
    status: "published",
    updated_at: "2026-08-10T00:00:00.000Z",
    upvote_count: 0,
    visibility: "public",
    ...overrides,
  }
}

describe("public song artifact grants", () => {
  test("extracts and normalizes upload ids only from media references", () => {
    expect(projectedPublicSongArtifactUploadIds(JSON.stringify({
      body: "/song-artifact-uploads/sau_not_media/content",
      media_refs: [
        { storage_ref: "https://api.pirate/public-communities/com_cmt_music/song-artifact-uploads/sau_sau_video/content?download=1" },
        { storage_ref: "https://api.pirate/communities/cmt_music/song-artifact-uploads/sau_audio/content" },
        { storage_ref: "https://api.pirate/public-communities/com_cmt_other/song-artifact-uploads/sau_cross_community/content" },
        { storage_ref: "https://example.invalid/public-communities/com_cmt_music/song-artifact-uploads/sau_untrusted_host/content" },
      ],
    }), "cmt_music")).toEqual(["sau_video", "sau_audio"])
  })

  test("adds and revokes indexed grants with projection visibility", async () => {
    const directory = mkdtempSync(join(tmpdir(), "public-artifact-grants-"))
    const sqlite = createClient({ url: `file:${join(directory, "grants.db")}` })
    const client = sqlite as unknown as Client
    try {
      await sqlite.execute(`
        CREATE TABLE public_song_artifact_grants (
          community_id TEXT NOT NULL,
          song_artifact_upload_id TEXT NOT NULL,
          source_post_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (community_id, song_artifact_upload_id, source_post_id)
        )
      `)
      await sqlite.execute("CREATE TABLE communities (community_id TEXT PRIMARY KEY, status TEXT NOT NULL)")
      await sqlite.execute(`
        CREATE TABLE community_post_projections (
          community_id TEXT NOT NULL,
          source_post_id TEXT NOT NULL,
          status TEXT NOT NULL,
          visibility TEXT NOT NULL,
          projected_payload_json TEXT NOT NULL,
          PRIMARY KEY (community_id, source_post_id)
        )
      `)
      const published = projection()
      await sqlite.execute({
        sql: "INSERT INTO communities (community_id, status) VALUES (?1, 'active')",
        args: [published.community_id],
      })
      await sqlite.execute({
        sql: `INSERT INTO community_post_projections (
          community_id, source_post_id, status, visibility, projected_payload_json
        ) VALUES (?1, ?2, ?3, ?4, ?5)`,
        args: [published.community_id, published.source_post_id, published.status, published.visibility, published.projected_payload_json],
      })
      await syncPublicSongArtifactGrantsForProjection(client, published)
      expect(await hasPublicSongArtifactGrant({
        client,
        communityId: published.community_id,
        songArtifactUploadId: "sau_video",
      })).toBe(true)

      await sqlite.execute({
        sql: "UPDATE community_post_projections SET visibility = 'members_only' WHERE community_id = ?1 AND source_post_id = ?2",
        args: [published.community_id, published.source_post_id],
      })
      expect(await hasPublicSongArtifactGrant({ client, communityId: published.community_id, songArtifactUploadId: "sau_video" })).toBe(false)
      await sqlite.execute({
        sql: "UPDATE community_post_projections SET visibility = 'public' WHERE community_id = ?1 AND source_post_id = ?2",
        args: [published.community_id, published.source_post_id],
      })
      await sqlite.execute({
        sql: "UPDATE communities SET status = 'archived' WHERE community_id = ?1",
        args: [published.community_id],
      })
      expect(await hasPublicSongArtifactGrant({ client, communityId: published.community_id, songArtifactUploadId: "sau_video" })).toBe(false)
      await sqlite.execute({
        sql: "UPDATE communities SET status = 'active' WHERE community_id = ?1",
        args: [published.community_id],
      })

      await syncPublicSongArtifactGrantsForProjection(client, projection({ status: "removed" }))
      expect(await hasPublicSongArtifactGrant({
        client,
        communityId: published.community_id,
        songArtifactUploadId: "sau_video",
      })).toBe(false)
    } finally {
      sqlite.close()
      rmSync(directory, { force: true, recursive: true })
    }
  })

  test("falls back safely before the grant migration is applied", async () => {
    const directory = mkdtempSync(join(tmpdir(), "public-artifact-grants-legacy-"))
    const sqlite = createClient({ url: `file:${join(directory, "grants.db")}` })
    const client = sqlite as unknown as Client
    try {
      expect(await hasPublicSongArtifactGrant({
        client,
        communityId: "cmt_music",
        songArtifactUploadId: "sau_video",
      })).toBe(false)
      await expect(syncPublicSongArtifactGrantsForProjection(client, projection())).resolves.toBeUndefined()
    } finally {
      sqlite.close()
      rmSync(directory, { force: true, recursive: true })
    }
  })
})
