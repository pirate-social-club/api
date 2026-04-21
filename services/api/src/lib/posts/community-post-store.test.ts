import { describe, expect, test } from "bun:test"

import type { CreatePostRequest, Post } from "../../types"
import { assertPostCreateRequest, sortPublishedLocalizedPostFeedItems } from "./community-post-store"

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

describe("assertPostCreateRequest", () => {
  test("rejects titles on link posts", () => {
    const body = {
      idempotency_key: "link-title",
      post_type: "link",
      title: "User-authored link title",
      link_url: "https://example.com/story",
    } as unknown as CreatePostRequest

    expect(() => assertPostCreateRequest(body, "cmt_test")).toThrow("title is not allowed for link posts")
  })
})
