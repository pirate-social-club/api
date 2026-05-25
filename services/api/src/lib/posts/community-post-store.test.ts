import { afterEach, describe, expect, test } from "bun:test"
import { createClient } from "@libsql/client"

import type { CreatePostRequest, Post } from "../../types"
import { assertPostCreateRequest, getPostById, insertPost, sortPublishedLocalizedPostFeedItems } from "./community-post-store"
import { MAX_POST_JSON_PROJECTION_LENGTH } from "./community-post-projection"

const clients: Array<{ close: () => void }> = []

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.close()
  }
})

function createFeedItem(input: {
  body?: string
  caption?: string
  commentCount?: number
  createdAt: string
  downvotes?: number
  id: string
  likes?: number
  mediaCount?: number
  title?: string
  upvotes?: number
}) {
  return {
    comment_count: input.commentCount ?? 0,
    downvote_count: input.downvotes ?? 0,
    like_count: input.likes ?? 0,
    post: {
      post_id: input.id,
      community_id: "cmt_test",
      author_user_id: "usr_test",
      authorship_mode: "human_direct",
      agent_id: null,
      agent_ownership_record_id: null,
      identity_mode: "public",
      anonymous_scope: null,
      anonymous_label: null,
      agent_handle_snapshot: null,
      agent_display_name_snapshot: null,
      agent_owner_handle_snapshot: null,
      agent_ownership_provider_snapshot: null,
      disclosed_qualifiers_json: null,
      label_id: null,
      post_type: "text",
      status: "published",
      visibility: "public",
      title: input.title ?? null,
      body: input.body ?? "",
      caption: input.caption ?? null,
      link_url: null,
      media_refs: Array.from({ length: input.mediaCount ?? 0 }, (_, index) => ({
        alt_text: null,
        blurhash: null,
        duration_seconds: null,
        height: 100,
        media_kind: "image",
        mime_type: "image/jpeg",
        position: index,
        preview_storage_ref: null,
        storage_ref: `media_${input.id}_${index}`,
        width: 100,
      })),
      song_artifact_bundle_id: null,
      source_language: "en",
      translation_policy: "none",
      access_mode: null,
      asset_id: null,
      parent_post_id: null,
      song_mode: null,
      rights_basis: "none",
      analysis_state: "allow",
      analysis_result_ref: null,
      content_safety_state: "safe",
      age_gate_policy: "none",
      created_at: input.createdAt,
      updated_at: input.createdAt,
    } satisfies Post,
    upvote_count: input.upvotes ?? 0,
    viewer_vote: null,
  }
}

async function createPostStoreTables(client: ReturnType<typeof createClient>, input: {
  crosspostSourceJson?: boolean
} = {}) {
  await client.execute(`
    CREATE TABLE posts (
      post_id TEXT PRIMARY KEY,
      community_id TEXT NOT NULL,
      author_user_id TEXT,
      authorship_mode TEXT NOT NULL,
      agent_id TEXT,
      agent_ownership_record_id TEXT,
      identity_mode TEXT NOT NULL,
      anonymous_scope TEXT,
      anonymous_label TEXT,
      agent_display_name_snapshot TEXT,
      agent_owner_handle_snapshot TEXT,
      agent_ownership_provider_snapshot TEXT,
      agent_handle_snapshot TEXT,
      disclosed_qualifiers_json TEXT,
      label_id TEXT,
      label_assignment_status TEXT,
      label_assigned_by TEXT,
      label_assigned_at TEXT,
      label_ai_confidence REAL,
      label_assignment_error TEXT,
      label_assignment_model TEXT,
      label_assignment_result_json TEXT,
      post_type TEXT NOT NULL,
      status TEXT NOT NULL,
      comments_locked INTEGER NOT NULL DEFAULT 0,
      comments_locked_at TEXT,
      comments_locked_by_user_id TEXT,
      comments_lock_reason TEXT,
      visibility TEXT NOT NULL,
      title TEXT,
      body TEXT,
      caption TEXT,
      lyrics TEXT,
      link_url TEXT,
      link_og_image_url TEXT,
      link_og_title TEXT,
      link_enrichment_snapshot_json TEXT,
      link_enrichment_synced_at TEXT,
      embeds_json TEXT,
      media_refs_json TEXT,
      song_artifact_bundle_id TEXT,
      song_title TEXT,
      song_annotations_url TEXT,
      song_cover_art_ref TEXT,
      song_duration_ms INTEGER,
      source_language TEXT,
      translation_policy TEXT,
      access_mode TEXT,
      asset_id TEXT,
      parent_post_id TEXT,
      ${input.crosspostSourceJson === false ? "" : "crosspost_source_json TEXT,"}
      upstream_asset_refs_json TEXT,
      source_start_ms INTEGER,
      source_duration_ms INTEGER,
      sync_offset_ms INTEGER,
      song_mode TEXT,
      rights_basis TEXT,
      analysis_state TEXT NOT NULL,
      analysis_result_ref TEXT,
      content_safety_state TEXT NOT NULL,
      age_gate_policy TEXT NOT NULL,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `)
  await client.execute(`
    CREATE TABLE live_rooms (
      live_room_id TEXT PRIMARY KEY,
      anchor_post_id TEXT,
      status TEXT NOT NULL DEFAULT 'open',
      visibility TEXT NOT NULL DEFAULT 'public'
    )
  `)
}

describe("sortPublishedLocalizedPostFeedItems", () => {
  const now = Date.parse("2026-04-19T12:00:00.000Z")
  const recentPlain = createFeedItem({
    body: "tiny",
    createdAt: "2026-04-19T11:00:00.000Z",
    id: "pst_recent",
    title: "Recent",
  })
  const midRich = createFeedItem({
    body: "This one has a much longer body for richness sorting.",
    createdAt: "2026-04-19T09:00:00.000Z",
    id: "pst_rich",
    mediaCount: 1,
    title: "Rich post",
  })
  const oldEngaged = createFeedItem({
    body: "older engaged",
    commentCount: 2,
    createdAt: "2026-04-18T10:00:00.000Z",
    id: "pst_engaged",
    likes: 1,
    title: "Engaged",
    upvotes: 3,
  })

  test("sorts new by created_at descending", () => {
    const sorted = sortPublishedLocalizedPostFeedItems([oldEngaged, midRich, recentPlain], "new", now)

    expect(sorted.map((item) => item.post.post_id)).toEqual([
      "pst_recent",
      "pst_rich",
      "pst_engaged",
    ])
  })

  test("sorts top by engagement and richness before recency", () => {
    const sorted = sortPublishedLocalizedPostFeedItems([recentPlain, oldEngaged, midRich], "top", now)

    expect(sorted.map((item) => item.post.post_id)).toEqual([
      "pst_engaged",
      "pst_rich",
      "pst_recent",
    ])
  })

  test("sorts best with time decay applied to weighted engagement", () => {
    const sorted = sortPublishedLocalizedPostFeedItems([recentPlain, oldEngaged, midRich], "best", now)

    expect(sorted.map((item) => item.post.post_id)).toEqual([
      "pst_rich",
      "pst_recent",
      "pst_engaged",
    ])
  })
})

describe("getPostById", () => {
  test("does not hydrate oversized JSON projection columns into the post response", async () => {
    const client = createClient({ url: "file::memory:" })
    clients.push(client)
    await createPostStoreTables(client)
    await client.execute({
      sql: `
        INSERT INTO posts (
          post_id, community_id, author_user_id, authorship_mode, identity_mode,
          label_assignment_status, post_type, status, visibility, title, body, link_url,
          link_enrichment_snapshot_json, embeds_json, media_refs_json, source_language,
          translation_policy, rights_basis, analysis_state, content_safety_state,
          age_gate_policy, idempotency_key, created_at, updated_at
        ) VALUES (
          'pst_oversized', 'cmt_test', 'usr_test', 'human_direct', 'public',
          'pending', 'link', 'published', 'public', 'Oversized', 'body', 'https://example.com',
          ?1, ?1, ?1, 'en',
          'none', 'none', 'allow', 'safe',
          'none', 'oversized', '2026-05-06T00:00:00.000Z', '2026-05-06T00:00:00.000Z'
        )
      `,
      args: ["x".repeat(MAX_POST_JSON_PROJECTION_LENGTH + 1)],
    })

    const post = await getPostById(client, "pst_oversized")

    expect(post?.link_enrichment_snapshot_json?.error).toBe("link_enrichment_snapshot_too_large")
    expect(post?.embeds).toBe(undefined)
    expect(post?.media_refs).toBe(undefined)
  })

  test("reads and writes non-crosspost rows before the crosspost migration is applied", async () => {
    const client = createClient({ url: "file::memory:" })
    clients.push(client)
    await createPostStoreTables(client, { crosspostSourceJson: false })

    const created = await insertPost({
      client,
      communityId: "cmt_test",
      authorUserId: "usr_test",
      body: {
        idempotency_key: "pre-crosspost-migration",
        post_type: "text",
        title: "Pre-migration post",
        body: "This should not require crosspost_source_json.",
      },
      createdAt: "2026-05-06T00:00:00.000Z",
    })
    const read = await getPostById(client, created.post_id)

    expect(created.crosspost_source).toBeNull()
    expect(read?.title).toBe("Pre-migration post")
    expect(read?.crosspost_source).toBeNull()
  })

  test("persists source timing for licensed performance video posts", async () => {
    const client = createClient({ url: "file::memory:" })
    clients.push(client)
    await createPostStoreTables(client)

    const created = await insertPost({
      client,
      communityId: "cmt_test",
      authorUserId: "usr_test",
      body: {
        idempotency_key: "licensed-performance-video",
        post_type: "video",
        title: "Dance take",
        rights_basis: "licensed_performance",
        upstream_asset_refs: ["story:asset:ast_source_song"],
        source_start_ms: 12_000,
        source_duration_ms: 15_000,
        sync_offset_ms: -250,
        media_refs: [{
          storage_ref: "video_upload",
          mime_type: "video/mp4",
        }],
      },
      createdAt: "2026-05-06T00:00:00.000Z",
    })
    const read = await getPostById(client, created.post_id)

    expect(created.rights_basis).toBe("licensed_performance")
    expect(created.upstream_asset_refs).toEqual(["story:asset:ast_source_song"])
    expect(created.source_start_ms).toBe(12_000)
    expect(created.source_duration_ms).toBe(15_000)
    expect(created.sync_offset_ms).toBe(-250)
    expect(read?.source_start_ms).toBe(12_000)
    expect(read?.source_duration_ms).toBe(15_000)
    expect(read?.sync_offset_ms).toBe(-250)
  })
})

describe("assertPostCreateRequest", () => {
  function originalSongRequest(overrides: Partial<CreatePostRequest> = {}): CreatePostRequest {
    return {
      idempotency_key: "song-license",
      post_type: "song",
      identity_mode: "public",
      song_artifact_bundle: "sab_test",
      song_mode: "original",
      rights_basis: "original",
      license_preset: "non-commercial",
      ...overrides,
    } as unknown as CreatePostRequest
  }

  function videoAssetRequest(overrides: Partial<CreatePostRequest> = {}): CreatePostRequest {
    return {
      idempotency_key: "video-license",
      post_type: "video",
      identity_mode: "public",
      access_mode: "locked",
      license_preset: "non-commercial",
      media_refs: [{
        storage_ref: "video_upload",
        mime_type: "video/mp4",
      }],
      ...overrides,
    } as CreatePostRequest
  }

  test("allows titles and body text on link posts", () => {
    const body = {
      idempotency_key: "link-title",
      post_type: "link",
      title: "User-authored link title",
      body: "User-authored commentary.",
      link_url: "https://example.com/story",
    } satisfies CreatePostRequest

    expect(() => assertPostCreateRequest(body, "cmt_test")).not.toThrow()
  })

  test("allows title-only crosspost requests with source references", () => {
    const body = {
      idempotency_key: "crosspost-ok",
      post_type: "crosspost",
      title: "Bringing this here",
      source_post: "post_pst_source",
      source_community: "com_cmt_music",
    } satisfies CreatePostRequest

    expect(() => assertPostCreateRequest(body, "cmt_test")).not.toThrow()
  })

  test("rejects crossposts with reply or body fields", () => {
    expect(() =>
      assertPostCreateRequest(
        {
          idempotency_key: "crosspost-reply",
          post_type: "crosspost",
          title: "Reply crosspost",
          source_post: "post_pst_source",
          source_community: "com_cmt_music",
          parent_post_id: "pst_parent",
        } as CreatePostRequest,
        "cmt_test",
      )
    ).toThrow("crossposts cannot be replies")

    expect(() =>
      assertPostCreateRequest(
        {
          idempotency_key: "crosspost-body",
          post_type: "crosspost",
          title: "Body crosspost",
          body: "commentary",
          source_post: "post_pst_source",
          source_community: "com_cmt_music",
        } as CreatePostRequest,
        "cmt_test",
      )
    ).toThrow("body is not supported for crossposts")
  })

  test("requires a license preset for original song posts", () => {
    expect(() => assertPostCreateRequest(originalSongRequest({ license_preset: null }), "cmt_test"))
      .toThrow("license_preset is required for original song posts")
  })

  test("allows original non-commercial and commercial-use song licenses without revenue share", () => {
    expect(() => assertPostCreateRequest(originalSongRequest({ license_preset: "non-commercial" }), "cmt_test"))
      .not.toThrow()
    expect(() => assertPostCreateRequest(originalSongRequest({ license_preset: "commercial-use" }), "cmt_test"))
      .not.toThrow()
  })

  test("rejects revenue share outside commercial-remix licenses", () => {
    expect(() =>
      assertPostCreateRequest(
        originalSongRequest({
          license_preset: "commercial-use",
          commercial_rev_share_pct: 10,
        }),
        "cmt_test",
      )
    ).toThrow("commercial_rev_share_pct is only supported for commercial-remix")
  })

  test("requires integer revenue share for original commercial-remix licenses", () => {
    expect(() =>
      assertPostCreateRequest(
        originalSongRequest({
          license_preset: "commercial-remix",
          commercial_rev_share_pct: null,
        }),
        "cmt_test",
      )
    ).toThrow("commercial_rev_share_pct must be an integer from 0 to 100 for commercial-remix")

    expect(() =>
      assertPostCreateRequest(
        originalSongRequest({
          license_preset: "commercial-remix",
          commercial_rev_share_pct: 12.5,
        }),
        "cmt_test",
      )
    ).toThrow("commercial_rev_share_pct must be an integer from 0 to 100 for commercial-remix")

    expect(() =>
      assertPostCreateRequest(
        originalSongRequest({
          license_preset: "commercial-remix",
          commercial_rev_share_pct: 10,
        }),
        "cmt_test",
      )
    ).not.toThrow()
  })

  test("requires a license preset for remix song posts", () => {
    expect(() =>
      assertPostCreateRequest(
        originalSongRequest({
          song_mode: "remix",
          rights_basis: "derivative",
          upstream_asset_refs: ["story:asset:ast_source_song"],
          license_preset: null,
        }),
        "cmt_test",
      )
    ).toThrow("license_preset is required for song posts")
  })

  test("allows outbound license fields on remix song posts", () => {
    expect(() =>
      assertPostCreateRequest(
        originalSongRequest({
          song_mode: "remix",
          rights_basis: "derivative",
          upstream_asset_refs: ["story:asset:ast_source_song"],
          license_preset: "commercial-remix",
          commercial_rev_share_pct: 10,
        }),
        "cmt_test",
      )
    ).not.toThrow()
  })

  test("requires a license preset for locked video asset posts", () => {
    expect(() => assertPostCreateRequest(videoAssetRequest({ license_preset: null }), "cmt_test"))
      .toThrow("license_preset is required for original video posts")
  })

  test("allows original video commercial-remix licenses with revenue share", () => {
    expect(() =>
      assertPostCreateRequest(
        videoAssetRequest({
          license_preset: "commercial-remix",
          commercial_rev_share_pct: 10,
        }),
        "cmt_test",
      )
    ).not.toThrow()
  })

  test("allows licensed performance video posts with source timing", () => {
    expect(() =>
      assertPostCreateRequest(
        videoAssetRequest({
          access_mode: undefined,
          license_preset: undefined,
          rights_basis: "licensed_performance",
          upstream_asset_refs: ["story:asset:ast_source_song"],
          source_start_ms: 12_000,
          source_duration_ms: 15_000,
          sync_offset_ms: -250,
        }),
        "cmt_test",
      )
    ).not.toThrow()
  })

  test("requires source metadata for licensed performance video posts", () => {
    expect(() =>
      assertPostCreateRequest(
        videoAssetRequest({
          access_mode: undefined,
          license_preset: undefined,
          rights_basis: "licensed_performance",
          upstream_asset_refs: [],
          source_start_ms: 12_000,
          source_duration_ms: 15_000,
        }),
        "cmt_test",
      )
    ).toThrow("licensed performance video posts require upstream_asset_refs")

    expect(() =>
      assertPostCreateRequest(
        videoAssetRequest({
          access_mode: undefined,
          license_preset: undefined,
          rights_basis: "licensed_performance",
          upstream_asset_refs: ["story:asset:ast_source_song"],
          source_start_ms: 12_000,
        }),
        "cmt_test",
      )
    ).toThrow("licensed performance video posts require source_duration_ms")
  })

  test("keeps derivative video posts blocked", () => {
    expect(() =>
      assertPostCreateRequest(
        videoAssetRequest({
          access_mode: undefined,
          license_preset: undefined,
          rights_basis: "derivative",
          upstream_asset_refs: ["story:asset:ast_source_song"],
        }),
        "cmt_test",
      )
    ).toThrow("derivative video posts are not supported yet")
  })

  test("rejects video license fields when no locked video asset is created", () => {
    expect(() =>
      assertPostCreateRequest(
        videoAssetRequest({
          access_mode: undefined,
          license_preset: "non-commercial",
        }),
        "cmt_test",
      )
    ).toThrow("license_preset is only supported for locked video asset posts")
    expect(() =>
      assertPostCreateRequest(
        videoAssetRequest({
          access_mode: "public",
          license_preset: "non-commercial",
        }),
        "cmt_test",
      )
    ).toThrow("license_preset is only supported for locked video asset posts")
  })

  test("rejects outbound license fields on non-asset posts", () => {
    expect(() =>
      assertPostCreateRequest(
        {
          idempotency_key: "link-license",
          post_type: "link",
          link_url: "https://example.com",
          license_preset: "non-commercial",
        } as CreatePostRequest,
        "cmt_test",
      )
    ).toThrow("license_preset is only supported for original asset posts")
  })
})
