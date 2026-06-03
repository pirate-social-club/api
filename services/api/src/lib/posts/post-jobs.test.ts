import { describe, expect, test } from "bun:test"
import { embedRecheckIntervalMs, linkPostNeedsHydrationOnRead, linkPostNeedsSummaryRepairOnRead } from "./post-jobs"
import type { Post } from "../../types"

type PostEmbed = NonNullable<Post["embeds"]>[number]

function embed(provider: PostEmbed["provider"], status?: string | null): PostEmbed {
  return {
    embed: `emb_${provider}`,
    embed_key: `${provider}:example`,
    provider,
    provider_ref: "example",
    canonical_url: "https://example.test/market",
    original_url: "https://example.test/market",
    state: "embed",
    preview: status === undefined ? null : { status },
    oembed_html: null,
    oembed_cache_age: null,
    unavailable_reason: null,
    last_checked_at: null,
  } as PostEmbed
}

function linkPost(overrides: Partial<Post> = {}): Post {
  return {
    post_id: "pst_test",
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
    label_assignment_status: "pending",
    label_assigned_by: null,
    label_assigned_at: null,
    label_ai_confidence: null,
    label_assignment_error: null,
    label_assignment_model: null,
    label_assignment_result_json: null,
    post_type: "link",
    status: "published",
    visibility: "public",
    title: null,
    body: null,
    caption: null,
    lyrics: null,
    link_url: "https://example.test/story",
    link_og_image_url: null,
    link_og_title: null,
    link_enrichment_snapshot_json: null,
    link_enrichment_synced_at: null,
    embeds: undefined,
    media_refs: undefined,
    song_artifact_bundle_id: null,
    source_language: "en",
    translation_policy: "machine_allowed",
    access_mode: null,
    asset_id: null,
    parent_post_id: null,
    upstream_asset_refs: undefined,
    song_mode: null,
    rights_basis: "none",
    analysis_state: "allow",
    analysis_result_ref: null,
    content_safety_state: "safe",
    age_gate_policy: "none",
    created_at: "2026-05-02T09:00:00.000Z",
    updated_at: "2026-05-02T09:00:00.000Z",
    ...overrides,
  }
}

describe("post embed recheck intervals", () => {
  test("uses a short interval for active prediction markets", () => {
    expect(embedRecheckIntervalMs(embed("kalshi", "open"))).toBe(5 * 60 * 1000)
    expect(embedRecheckIntervalMs(embed("polymarket", "active"))).toBe(5 * 60 * 1000)
    expect(embedRecheckIntervalMs(embed("kalshi", null))).toBe(5 * 60 * 1000)
  })

  test("keeps a daily interval for closed prediction markets and static embeds", () => {
    expect(embedRecheckIntervalMs(embed("kalshi", "closed"))).toBe(24 * 60 * 60 * 1000)
    expect(embedRecheckIntervalMs(embed("polymarket", "settled"))).toBe(24 * 60 * 60 * 1000)
    expect(embedRecheckIntervalMs(embed("x"))).toBe(24 * 60 * 60 * 1000)
    expect(embedRecheckIntervalMs(embed("youtube"))).toBe(24 * 60 * 60 * 1000)
  })
})

describe("link post hydration on read", () => {
  test("retries generic link posts that have no enrichment snapshot", () => {
    expect(linkPostNeedsHydrationOnRead(linkPost())).toBe(true)
  })

  test("does not rehydrate generic link posts that already have an enrichment snapshot", () => {
    expect(linkPostNeedsHydrationOnRead(linkPost({
      link_enrichment_snapshot_json: {
        version: 1,
        status: "ready",
        title: "Example story",
      },
    }))).toBe(false)
  })

  test("does not use embed hydration for generic link posts with existing failed summary snapshots", () => {
    expect(linkPostNeedsHydrationOnRead(linkPost({
      link_enrichment_snapshot_json: {
        version: 1,
        status: "ready",
        summary: {
          status: "failed",
          summary_paragraph: null,
          short_summary: null,
          key_points: [],
        },
        error: "OpenRouter link summary response schema mismatch: invalid summary_paragraph",
      },
    }))).toBe(false)
  })

  test("repairs generic link posts with retryable failed summary snapshots through the summary job", () => {
    expect(linkPostNeedsSummaryRepairOnRead(linkPost({
      link_enrichment_snapshot_json: {
        version: 1,
        status: "ready",
        normalized_url: "https://example.test/story",
        summary: {
          status: "failed",
          summary_paragraph: null,
          short_summary: null,
          key_points: [],
        },
        error: "OpenRouter link summary request failed with http_401",
      },
    }))).toBe(true)
  })

  test("keeps stale embed rechecks for supported embeds", () => {
    expect(linkPostNeedsHydrationOnRead(linkPost({
      embeds: [
        {
          ...embed("youtube"),
          last_checked_at: 1777625940,
        },
      ],
      link_enrichment_snapshot_json: {
        version: 1,
        status: "ready",
      },
    }), "2026-05-02T09:00:00.000Z")).toBe(true)
  })
})
