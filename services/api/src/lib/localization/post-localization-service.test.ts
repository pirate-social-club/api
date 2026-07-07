import { describe, expect, test } from "bun:test"
import { buildLocalizedPostResponse } from "./post-localization-service"
import { buildLocalizedPostFeedResponses } from "../posts/post-read-response"
import type { DbExecutor } from "../db-helpers"
import type { PublishedLocalizedPostFeedItem } from "../posts/community-post-feed"
import type { Client } from "../sql-client"
import type { Post } from "../../types"

function emptyExecutor(): DbExecutor {
  return {
    async execute() {
      return { rows: [] }
    },
  } as DbExecutor
}

function studyEnabledExecutor(input: {
  entitlementRows?: Record<string, unknown>[]
  onEntitlementQuery?: () => void
} = {}): DbExecutor {
  return {
    async execute(query) {
      const sql = typeof query === "string" ? query : query.sql
      if (String(sql).includes("PRAGMA table_info(communities)")) {
        return { rows: [{ name: "study_enabled" }] }
      }
      if (String(sql).includes("FROM communities")) {
        return { rows: [{ study_enabled: 1 }] }
      }
      if (String(sql).includes("FROM purchase_entitlements")) {
        input.onEntitlementQuery?.()
        return {
          rows: input.entitlementRows ?? [{
            purchase_entitlement_id: "pe_study",
            purchase_id: "pur_study",
            community_id: "cmt_music",
            buyer_kind: "user",
            buyer_user_id: "usr_fan",
            buyer_wallet_address: null,
            buyer_wallet_address_normalized: null,
            buyer_chain_ref: null,
            entitlement_kind: "asset_access",
            target_ref: "ast_song",
            status: "active",
            granted_at: "2026-06-03T00:00:00.000Z",
            revoked_at: null,
            created_at: "2026-06-03T00:00:00.000Z",
            updated_at: "2026-06-03T00:00:00.000Z",
          }],
        }
      }
      return { rows: [] }
    },
  } as DbExecutor
}

function studyDisabledExecutor(input: {
  onEntitlementQuery?: () => void
} = {}): DbExecutor {
  return {
    async execute(query) {
      const sql = typeof query === "string" ? query : query.sql
      if (String(sql).includes("PRAGMA table_info(communities)")) {
        return { rows: [{ name: "study_enabled" }] }
      }
      if (String(sql).includes("FROM communities")) {
        return { rows: [{ study_enabled: 0 }] }
      }
      if (String(sql).includes("FROM purchase_entitlements")) {
        input.onEntitlementQuery?.()
      }
      return { rows: [] }
    },
  } as DbExecutor
}

function studyPolicyCountingExecutor(input: {
  studyEnabled?: boolean
} = {}): { executor: DbExecutor; studyPolicyQueryCount: () => number } {
  let studyPolicyQueries = 0
  return {
    executor: {
      async execute(query) {
        const sql = typeof query === "string" ? query : query.sql
        if (String(sql).includes("PRAGMA table_info(communities)")) {
          studyPolicyQueries += 1
          return { rows: [{ name: "study_enabled" }] }
        }
        if (String(sql).includes("SELECT study_enabled") && String(sql).includes("FROM communities")) {
          studyPolicyQueries += 1
          return { rows: [{ study_enabled: input.studyEnabled === false ? 0 : 1 }] }
        }
        return { rows: [] }
      },
    } as DbExecutor,
    studyPolicyQueryCount: () => studyPolicyQueries,
  }
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
          alignment_status: "completed",
          timed_lyrics_ref: null,
          timed_lyrics_json: {
            provider: "elevenlabs",
            segments: [{
              start_ms: 100,
              end_ms: 500,
              text: "hello",
            }],
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

function makeTextPost(postId: string): Post {
  return {
    ...makeSongPost(),
    post_id: postId,
    post_type: "text",
    title: "Text post",
    body: "Body",
    lyrics: null,
    song_artifact_bundle_id: null,
    song_title: null,
    song_cover_art_ref: null,
    song_duration_ms: null,
    song_mode: null,
    rights_basis: null,
    upstream_asset_refs: null,
  }
}

function makeFeedItem(post: Post): PublishedLocalizedPostFeedItem {
  return {
    post,
    upvote_count: 0,
    downvote_count: 0,
    comment_count: 0,
    like_count: 0,
    viewer_vote: null,
  }
}

const activeElevenLabsCredential = async () => true
const inactiveElevenLabsCredential = async () => false

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
    expect(response.song_presentation?.alignment_status).toBe("completed")
    expect(response.song_presentation?.has_timed_lyrics).toBe(true)
    expect("timed_lyrics_ref" in (response.song_presentation ?? {})).toBe(false)
    expect("timed_lyrics" in (response.song_presentation ?? {})).toBe(false)
  })

  test("keeps karaoke readiness redacted for locked songs", async () => {
    const response = await buildLocalizedPostResponse({
      executor: emptyExecutor(),
      songArtifactExecutor: songArtifactExecutor(),
      post: {
        ...makeSongPost(),
        access_mode: "locked",
      },
    })

    expect(response.song_presentation).toEqual({
      title: "Arkansas Blues",
      cover_art_ref: "https://media.test/cover.jpg",
      duration_ms: null,
      downloadable_audio: null,
      alignment_status: null,
      has_timed_lyrics: null,
    })
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

  test("adds a ready study capability for public songs with lyrics", async () => {
    const response = await buildLocalizedPostResponse({
      executor: studyEnabledExecutor(),
      post: {
        ...makeSongPost(),
        lyrics: "Line one\nLine two",
        source_language: "en",
      },
      studyElevenLabsCredentialResolver: activeElevenLabsCredential,
    })

    expect(response.study_capability).toEqual({
      status: "ready",
      exercise_count: 2,
      source_language: "en",
      target_language: "en",
    })
  })

  test("marks same-language study unavailable without a say-it-back provider", async () => {
    const response = await buildLocalizedPostResponse({
      executor: studyEnabledExecutor(),
      post: {
        ...makeSongPost(),
        lyrics: "Line one\nLine two",
        source_language: "en",
      },
      studyElevenLabsCredentialResolver: inactiveElevenLabsCredential,
    })

    expect(response.study_capability).toEqual({
      status: "unavailable",
      source_language: "en",
      target_language: "en",
    })
  })

  test("feed study capability skips study policy queries for non-song posts", async () => {
    const counted = studyPolicyCountingExecutor()

    const responses = await buildLocalizedPostFeedResponses({
      client: counted.executor as Client,
      feedItems: [
        makeFeedItem(makeTextPost("pst_text_1")),
        makeFeedItem(makeTextPost("pst_text_2")),
      ],
      viewerUserId: "usr_fan",
      ageGateState: null,
      studyElevenLabsCredentialResolver: activeElevenLabsCredential,
    })

    expect(responses.map((response) => response.study_capability)).toEqual([null, null])
    expect(counted.studyPolicyQueryCount()).toBe(0)
  })

  test("feed study capability reuses the community study flag lookup across songs", async () => {
    const counted = studyPolicyCountingExecutor()

    const responses = await buildLocalizedPostFeedResponses({
      client: counted.executor as Client,
      feedItems: [
        makeFeedItem({
          ...makeSongPost(),
          post_id: "pst_song_1",
          lyrics: "Line one",
          source_language: "en",
        }),
        makeFeedItem({
          ...makeSongPost(),
          post_id: "pst_song_2",
          lyrics: "Line two",
          source_language: "en",
        }),
      ],
      viewerUserId: "usr_fan",
      ageGateState: null,
      studyElevenLabsCredentialResolver: activeElevenLabsCredential,
    })

    expect(responses.map((response) => response.study_capability?.status)).toEqual(["ready", "ready"])
    expect(counted.studyPolicyQueryCount()).toBe(2)
  })

  test("adds a locked study capability for locked songs without entitlement", async () => {
    const response = await buildLocalizedPostResponse({
      executor: studyEnabledExecutor({ entitlementRows: [] }),
      post: {
        ...makeSongPost(),
        access_mode: "locked",
        asset_id: "ast_song",
        lyrics: "Line one",
      },
      viewerUserId: "usr_fan",
    })

    expect(response.study_capability?.status).toBe("locked")
  })

  test("adds a ready study capability for locked songs with entitlement", async () => {
    const response = await buildLocalizedPostResponse({
      executor: studyEnabledExecutor(),
      post: {
        ...makeSongPost(),
        access_mode: "locked",
        asset_id: "ast_song",
        lyrics: "Line one",
      },
      studyElevenLabsCredentialResolver: activeElevenLabsCredential,
      viewerUserId: "usr_fan",
    })

    expect(response.study_capability?.status).toBe("ready")
  })

  test("omits study capability when community study is disabled before entitlement lookup", async () => {
    let entitlementQueries = 0
    const response = await buildLocalizedPostResponse({
      executor: studyDisabledExecutor({
        onEntitlementQuery() {
          entitlementQueries += 1
        },
      }),
      post: {
        ...makeSongPost(),
        access_mode: "locked",
        asset_id: "ast_song",
        lyrics: "Line one",
      },
      viewerUserId: "usr_fan",
    })

    expect(response.study_capability).toBeNull()
    expect(entitlementQueries).toBe(0)
  })

  test("omits study capability when the study_enabled column is absent", async () => {
    const response = await buildLocalizedPostResponse({
      executor: emptyExecutor(),
      post: {
        ...makeSongPost(),
        lyrics: "Line one",
      },
    })

    expect(response.study_capability).toBeNull()
  })
})
