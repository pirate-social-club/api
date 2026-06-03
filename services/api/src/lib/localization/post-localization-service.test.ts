import { describe, expect, test } from "bun:test"
import { buildLocalizedPostResponse } from "./post-localization-service"
import type { DbExecutor } from "../db-helpers"
import type { Post } from "../../types"

function emptyExecutor(): DbExecutor {
  return {
    async execute() {
      return { rows: [] }
    },
  } as DbExecutor
}

function songArtifactExecutor(): DbExecutor {
  return {
    async execute() {
      return {
        rows: [{
          primary_audio_json: {
            storage_ref: "https://media.test/original.mp3",
            mime_type: "audio/mpeg",
            size_bytes: 1000,
            duration_ms: 123000,
            filename: "original.mp3",
          },
          instrumental_audio_json: {
            storage_ref: "https://media.test/instrumental.mp3",
            mime_type: "audio/mpeg",
            size_bytes: 900,
            duration_ms: 123000,
          },
          vocal_audio_json: {
            storage_ref: "https://media.test/vocals.mp3",
            mime_type: "audio/mpeg",
            size_bytes: 800,
            duration_ms: 120000,
          },
        }],
      }
    },
  } as DbExecutor
}

function legacySongArtifactExecutor(): DbExecutor {
  return {
    async execute(query) {
      const sql = typeof query === "string" ? query : query.sql
      if (String(sql).includes("FROM song_artifact_uploads")) {
        return {
          rows: [{
            song_artifact_upload_id: "sau_original",
            ipfs_cid: "bafylegacysongcid",
          }],
        }
      }
      return {
        rows: [{
          primary_audio_json: {
            storage_ref: "https://api.pirate.sc/communities/cmt_music/song-artifact-uploads/sau_original/content",
            mime_type: "audio/mpeg",
            size_bytes: 1000,
            duration_ms: 123000,
            filename: "original.mp3",
          },
          instrumental_audio_json: null,
          vocal_audio_json: null,
        }],
      }
    },
  } as DbExecutor
}

function makeSongPost(): Post {
  return {
    post_id: "pst_song",
    community_id: "cmt_music",
    author_user_id: "usr_artist",
    authorship_mode: "human_direct",
    identity_mode: "public",
    post_type: "song",
    status: "published",
    visibility: "public",
    access_mode: "public",
    title: "Song post",
    body: null,
    caption: null,
    lyrics: null,
    media_refs: [],
    song_artifact_bundle_id: "sab_bundle",
    song_title: "Arkansas Blues",
    song_cover_art_ref: "https://media.test/cover.jpg",
    song_duration_ms: null,
    song_mode: "original",
    rights_basis: "original",
    upstream_asset_refs: [],
    analysis_state: "allow",
    content_safety_state: "safe",
    age_gate_policy: "none",
    created_at: "2026-06-03T00:00:00.000Z",
    updated_at: "2026-06-03T00:00:00.000Z",
  }
}

describe("buildLocalizedPostResponse", () => {
  test("maps object-valued song audio descriptors into downloadable audio", async () => {
    const response = await buildLocalizedPostResponse({
      executor: emptyExecutor(),
      songArtifactExecutor: songArtifactExecutor(),
      post: makeSongPost(),
    })

    expect(response.song_presentation?.downloadable_audio?.map((item) => ({
      kind: item.kind,
      storage_ref: item.storage_ref,
      mime_type: item.mime_type,
      duration_ms: item.duration_ms,
    }))).toEqual([
      {
        kind: "original",
        storage_ref: "https://media.test/original.mp3",
        mime_type: "audio/mpeg",
        duration_ms: 123000,
      },
      {
        kind: "instrumental",
        storage_ref: "https://media.test/instrumental.mp3",
        mime_type: "audio/mpeg",
        duration_ms: 123000,
      },
      {
        kind: "vocals",
        storage_ref: "https://media.test/vocals.mp3",
        mime_type: "audio/mpeg",
        duration_ms: 120000,
      },
    ])
  })

  test("enriches legacy song audio descriptors from upload IPFS CIDs", async () => {
    const storageRef = "https://api.pirate.sc/communities/cmt_music/song-artifact-uploads/sau_original/content"
    const response = await buildLocalizedPostResponse({
      executor: emptyExecutor(),
      songArtifactExecutor: legacySongArtifactExecutor(),
      post: {
        ...makeSongPost(),
        media_refs: [{
          storage_ref: storageRef,
          mime_type: "audio/mpeg",
        }],
      },
    })

    expect(response.song_presentation?.downloadable_audio?.[0]?.decentralized_storage).toEqual({
      provider: "filebase_ipfs",
      cid: "bafylegacysongcid",
      gateway_url: "https://dweb.link/ipfs/bafylegacysongcid",
    })
    expect(response.post.media_refs?.[0]?.decentralized_storage).toEqual({
      provider: "filebase_ipfs",
      cid: "bafylegacysongcid",
      gateway_url: "https://dweb.link/ipfs/bafylegacysongcid",
    })
  })
})
