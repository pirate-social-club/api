import { describe, expect, test } from "bun:test"
import { hydrateCrosspostSources } from "./crosspost-source-hydration"
import type { CommunityPostProjectionRow } from "../auth/auth-db-rows"
import type { Post } from "../../types"

function makeCrosspost(): Post {
  return {
    post_id: "crosspost_target",
    community_id: "target_community",
    author_user_id: "target_author",
    authorship_mode: "human_direct",
    identity_mode: "public",
    anonymous_scope: null,
    anonymous_label: null,
    post_type: "crosspost",
    title: "Target title",
    body: null,
    caption: null,
    lyrics: null,
    link_url: null,
    link_og_image_url: null,
    link_og_title: null,
    link_enrichment_snapshot_json: null,
    link_enrichment_synced_at: null,
    embeds: null,
    media_refs: [],
    song_artifact_bundle_id: null,
    song_artifact_bundle: null,
    parent_post_id: null,
    status: "published",
    visibility: "public",
    translation_policy: "machine_allowed",
    source_language: null,
    analysis_state: "allow",
    content_safety_state: "safe",
    age_gate_policy: "none",
    created_at: "2026-05-16T00:00:00.000Z",
    updated_at: "2026-05-16T00:00:00.000Z",
    crosspost_source: {
      status: "unavailable",
      post_id: "source_post",
      community_id: "source_community",
      captured_at: "2026-05-16T00:00:00.000Z",
    },
  } as Post
}

function makeProjection(overrides: Partial<CommunityPostProjectionRow> = {}): CommunityPostProjectionRow {
  return {
    projection_id: "projection",
    community_id: "source_community",
    source_post_id: "source_post",
    author_user_id: "source_author",
    identity_mode: "public",
    post_type: "image",
    status: "published",
    visibility: "public",
    source_created_at: "2026-05-15T00:00:00.000Z",
    projected_payload_json: JSON.stringify({
      title: "Source image title",
      media_refs: [{ storage_ref: "ipfs://source-image-cid", mime_type: "image/jpeg" }],
    }),
    upvote_count: 0,
    downvote_count: 0,
    comment_count: 0,
    like_count: 0,
    projection_version: 1,
    created_at: "2026-05-15T00:00:00.000Z",
    updated_at: "2026-05-15T00:00:00.000Z",
    ...overrides,
  }
}

describe("hydrateCrosspostSources", () => {
  test("hydrates available source state from live projections, communities, and profiles", async () => {
    const post = makeCrosspost()

    await hydrateCrosspostSources({
      posts: [post],
      communityRepository: {
        async getCommunityPostProjectionByPostId() {
          return makeProjection()
        },
        async getCommunityById() {
          return {
            community_id: "source_community",
            display_name: "@Music",
            route_slug: "music",
            status: "active",
            provisioning_state: "active",
          }
        },
      } as never,
      profileRepository: {
        async getProfileByUserId() {
          return null
        },
        async listProfilesByUserIds() {
          return new Map([
            ["source_author", {
              global_handle: { label: "source-author.pirate" },
              primary_public_handle: null,
            }],
          ])
        },
      } as never,
    })

    expect(post.crosspost_source).toMatchObject({
      status: "available",
      post_id: "source_post",
      community_id: "source_community",
      post_type: "image",
      title: "Source image title",
      community_label: "@Music",
      community_route_slug: "music",
      author_user_id: "source_author",
      author_label: "source-author.pirate",
      thumbnail_ref: "ipfs://source-image-cid",
    })
  })

  test("redacts source metadata when the projection is deleted", async () => {
    const post = makeCrosspost()

    await hydrateCrosspostSources({
      posts: [post],
      communityRepository: {
        async getCommunityPostProjectionByPostId() {
          return makeProjection({ status: "deleted" })
        },
        async getCommunityById() {
          return {
            community_id: "source_community",
            display_name: "@Music",
            route_slug: "music",
            status: "active",
            provisioning_state: "active",
          }
        },
      } as never,
    })

    expect(post.crosspost_source).toEqual({
      status: "deleted",
      post_id: "source_post",
      community_id: "source_community",
      captured_at: "2026-05-16T00:00:00.000Z",
    })
  })
})
