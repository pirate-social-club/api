import { describe, expect, test } from "bun:test"
import type { HomeFeedItem, Post } from "../../types"
import type { HomeFeedProjectionRow } from "./home-feed-types"
import {
  compareProjectedVideoFeedRows,
  shouldShadowAuthenticatedVideoFeed,
} from "./home-feed-control-plane-shadow"

function post(overrides: Partial<Post> = {}): Post {
  return {
    post_id: "pst_one",
    community_id: "cmt_one",
    author_user_id: "usr_one",
    authorship_mode: "human_direct",
    identity_mode: "public",
    post_type: "video",
    status: "published",
    visibility: "public",
    media_refs: [{ storage_ref: "media/video.mp4" }],
    analysis_state: "allow",
    content_safety_state: "safe",
    age_gate_policy: "none",
    created_at: "2026-07-25T00:00:00.000Z",
    updated_at: "2026-07-25T00:00:00.000Z",
    ...overrides,
  }
}

function row(overrides: Partial<HomeFeedProjectionRow> = {}): HomeFeedProjectionRow {
  const projectedPost = post()
  return {
    community_id: projectedPost.community_id,
    source_post_id: projectedPost.post_id,
    author_user_id: projectedPost.author_user_id,
    identity_mode: projectedPost.identity_mode,
    source_created_at: projectedPost.created_at,
    visibility: projectedPost.visibility,
    projected_payload_json: JSON.stringify(projectedPost),
    upvote_count: 0,
    downvote_count: 0,
    comment_count: 0,
    like_count: 0,
    post_type: projectedPost.post_type,
    ...overrides,
  }
}

function hydratedItem(projectedPost = post()): HomeFeedItem {
  return {
    post: {
      post: {
        ...projectedPost,
        id: `post_${projectedPost.post_id}`,
        object: "post",
      },
    },
  } as unknown as HomeFeedItem
}

describe("authenticated video-feed control-plane shadow", () => {
  test("only runs for explicitly enabled authenticated video requests", () => {
    expect(shouldShadowAuthenticatedVideoFeed({ contentKind: "video", mode: "shadow", userId: "usr_one" })).toBe(true)
    expect(shouldShadowAuthenticatedVideoFeed({ contentKind: "video", mode: "serve", userId: "usr_one" })).toBe(false)
    expect(shouldShadowAuthenticatedVideoFeed({ contentKind: "video", mode: "shadow", userId: null })).toBe(false)
  })

  test("reports a complete projection when structural fields and media match", () => {
    expect(compareProjectedVideoFeedRows({
      hydratedItems: [hydratedItem()],
      rows: [row()],
    })).toEqual({
      candidate_projection_complete: true,
      compared_items: 1,
      hydrated_items: 1,
      mismatch_reasons: {},
      projection_complete: true,
      projection_rows: 1,
      valid_projection_rows: 1,
    })
  })

  test("classifies malformed candidate payloads without throwing or hiding returned-item coverage", () => {
    const result = compareProjectedVideoFeedRows({
      hydratedItems: [hydratedItem()],
      rows: [
        row(),
        row({ source_post_id: "pst_bad_json", projected_payload_json: "{" }),
      ],
    })

    expect(result.candidate_projection_complete).toBe(false)
    expect(result.projection_complete).toBe(true)
    expect(result.mismatch_reasons).toEqual({
      invalid_json: 1,
    })
  })

  test("detects media drift for a returned item", () => {
    const result = compareProjectedVideoFeedRows({
      hydratedItems: [hydratedItem()],
      rows: [row({ projected_payload_json: post({ media_refs: [] }) })],
    })

    expect(result.projection_complete).toBe(false)
    expect(result.mismatch_reasons).toEqual({ media_mismatch: 1 })
  })
})
