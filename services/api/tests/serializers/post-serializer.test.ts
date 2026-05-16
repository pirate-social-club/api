import { describe, expect, test } from "bun:test"
import { serializeLocalizedPostResponse, serializePost } from "../../src/serializers/post"
import type { LocalizedPostResponse, Post } from "../../src/types"

function makeLinkPost(overrides: Partial<Post> = {}): Post {
  return {
    post_id: "pst_test_link",
    community_id: "cmt_test",
    author_user_id: "usr_test",
    authorship_mode: "human_direct",
    identity_mode: "public",
    post_type: "link",
    status: "published",
    visibility: "public",
    analysis_state: "pending",
    content_safety_state: "safe",
    age_gate_policy: "none",
    created_at: "2026-05-15T00:00:00.000Z",
    updated_at: "2026-05-15T00:00:00.000Z",
    link_url: "https://example.com/article",
    link_og_image_url: "https://example.com/og.png",
    link_og_title: "Original Title",
    source_language: "en",
    link_enrichment_snapshot_json: {
      version: 1,
      provider: "firecrawl",
      status: "ready",
      normalized_url: "https://example.com/article",
      canonical_url: "https://example.com/article",
      title: "Original English Title",
      description: "English description",
      source_language: "en",
      publisher: "Example",
      published_at: null,
      image_url: "https://example.com/og.png",
      summary: {
        status: "ready",
        summary_paragraph: "English summary paragraph",
        short_summary: "English short",
        key_points: ["point 1", "point 2"],
        generated_at: "2026-05-15T00:00:00.000Z",
        model: "test-model",
      },
      translations: {
        en: {
          locale: "en",
          title: "English Title",
          description: "English description",
          summary: {
            summary_paragraph: "English summary",
            short_summary: "English short",
            key_points: ["en point"],
          },
          generated_at: null,
          model: null,
          provider: null,
        },
        es: {
          locale: "es",
          title: "Spanish Title",
          description: "Spanish description",
          summary: {
            summary_paragraph: "Spanish summary",
            short_summary: "Spanish short",
            key_points: ["es point"],
          },
          generated_at: null,
          model: null,
          provider: null,
        },
        fr: {
          locale: "fr",
          title: "French Title",
          description: "French description",
          summary: {
            summary_paragraph: "French summary",
            short_summary: "French short",
            key_points: ["fr point"],
          },
          generated_at: null,
          model: null,
          provider: null,
        },
        de: {
          locale: "de",
          title: "German Title",
          description: "German description",
          summary: {
            summary_paragraph: "German summary",
            short_summary: "German short",
            key_points: ["de point"],
          },
          generated_at: null,
          model: null,
          provider: null,
        },
        ja: {
          locale: "ja",
          title: "Japanese Title",
          description: "Japanese description",
          summary: {
            summary_paragraph: "Japanese summary",
            short_summary: "Japanese short",
            key_points: ["ja point"],
          },
          generated_at: null,
          model: null,
          provider: null,
        },
      },
      error: null,
      fetched_at: "2026-05-15T00:00:00.000Z",
    },
    ...overrides,
  }
}

function makeLocalizedResponse(post: Post, resolvedLocale: string): LocalizedPostResponse {
  return {
    post,
    thread_snapshot: null,
    upvote_count: 10,
    downvote_count: 0,
    like_count: 5,
    comment_count: 3,
    viewer_vote: null,
    viewer_is_author: false,
    viewer_reaction_kinds: [],
    resolved_locale: resolvedLocale,
    translation_state: "same_language",
    machine_translated: false,
    translated_body: null,
    translated_title: null,
    translated_caption: null,
    source_hash: "abc123",
  }
}

describe("serializeLocalizedPostResponse feed pruning", () => {
  test("post serializer includes public live room status snapshot", () => {
    const result = serializePost(makeLinkPost({
      anchor_live_room_id: "lr_test",
      anchor_live_room_status: "live",
    }))

    expect(result.anchor_live_room).toBe("lr_test")
    expect(result.anchor_live_room_status).toBe("live")
  })

  test("home_feed surface keeps only resolved locale and source language translations", () => {
    const response = makeLocalizedResponse(makeLinkPost(), "es")
    const result = serializeLocalizedPostResponse(response, { surface: "home_feed" })
    const enrichment = result.post.link_enrichment as Record<string, unknown> | null
    expect(enrichment).not.toBeNull()

    const translations = enrichment!.translations as Record<string, unknown>
    const translationKeys = Object.keys(translations)
    expect(translationKeys).toContain("es")
    expect(translationKeys).toContain("en")
    expect(translationKeys).not.toContain("fr")
    expect(translationKeys).not.toContain("de")
    expect(translationKeys).not.toContain("ja")
  })

  test("home_feed surface keeps top-level enrichment fields intact", () => {
    const response = makeLocalizedResponse(makeLinkPost(), "es")
    const result = serializeLocalizedPostResponse(response, { surface: "home_feed" })
    const enrichment = result.post.link_enrichment as Record<string, unknown> | null
    expect(enrichment).not.toBeNull()
    expect(enrichment!.title).toBe("Original English Title")
    expect(enrichment!.description).toBe("English description")
    expect(enrichment!.source_language).toBe("en")
    expect(enrichment!.publisher).toBe("Example")
    expect(enrichment!.normalized_url).toBe("https://example.com/article")
    expect(enrichment!.image_url).toBe("https://example.com/og.png")
    expect(enrichment!.status).toBe("ready")
  })

  test("home_feed surface keeps summary intact", () => {
    const response = makeLocalizedResponse(makeLinkPost(), "es")
    const result = serializeLocalizedPostResponse(response, { surface: "home_feed" })
    const enrichment = result.post.link_enrichment as Record<string, unknown> | null
    const summary = enrichment!.summary as Record<string, unknown>
    expect(summary.short_summary).toBe("English short")
    expect(summary.summary_paragraph).toBe("English summary paragraph")
  })

  test("home_feed falls back to first translation when no locale or source matches", () => {
    const response = makeLocalizedResponse(makeLinkPost(), "zh")
    const result = serializeLocalizedPostResponse(response, { surface: "home_feed" })
    const enrichment = result.post.link_enrichment as Record<string, unknown> | null
    const translations = enrichment!.translations as Record<string, unknown>
    const translationKeys = Object.keys(translations)
    expect(translationKeys.length).toBeGreaterThanOrEqual(1)
    expect(translationKeys).toContain("en")
  })

  test("home_feed surface with single translation passes through unchanged", () => {
    const snapshot = {
      version: 1,
      provider: "firecrawl",
      status: "ready",
      normalized_url: "https://example.com/a",
      canonical_url: null,
      title: "Title",
      description: null,
      source_language: "en",
      publisher: null,
      published_at: null,
      image_url: null,
      summary: { status: null, summary_paragraph: null, short_summary: null, key_points: [], generated_at: null, model: null },
      translations: {
        en: { locale: "en", title: "Title", description: null, summary: { summary_paragraph: null, short_summary: null, key_points: [] }, generated_at: null, model: null, provider: null },
      },
      error: null,
      fetched_at: null,
    }
    const response = makeLocalizedResponse(makeLinkPost({ link_enrichment_snapshot_json: snapshot }), "en")
    const result = serializeLocalizedPostResponse(response, { surface: "home_feed" })
    const enrichment = result.post.link_enrichment as Record<string, unknown> | null
    const translations = enrichment!.translations as Record<string, unknown>
    expect(Object.keys(translations)).toEqual(["en"])
  })

  test("home_feed surface with null enrichment passes through unchanged", () => {
    const response = makeLocalizedResponse(makeLinkPost({ link_enrichment_snapshot_json: null }), "en")
    const result = serializeLocalizedPostResponse(response, { surface: "home_feed" })
    expect(result.post.link_enrichment).toBeNull()
  })

  test("without home_feed surface all translations are preserved", () => {
    const response = makeLocalizedResponse(makeLinkPost(), "es")
    const result = serializeLocalizedPostResponse(response)
    const enrichment = result.post.link_enrichment as Record<string, unknown> | null
    const translations = enrichment!.translations as Record<string, unknown>
    expect(Object.keys(translations)).toEqual(["en", "es", "fr", "de", "ja"])
  })

  test("home_feed surface matches base language variant", () => {
    const response = makeLocalizedResponse(makeLinkPost(), "es-MX")
    const result = serializeLocalizedPostResponse(response, { surface: "home_feed" })
    const enrichment = result.post.link_enrichment as Record<string, unknown> | null
    const translations = enrichment!.translations as Record<string, unknown>
    const translationKeys = Object.keys(translations)
    expect(translationKeys).toContain("es")
    expect(translationKeys).toContain("en")
    expect(translationKeys).not.toContain("fr")
    expect(translationKeys).not.toContain("de")
    expect(translationKeys).not.toContain("ja")
  })

  test("home_feed surface falls back to post source language when enrichment source language is missing", () => {
    const response = makeLocalizedResponse(
      makeLinkPost({
        link_enrichment_snapshot_json: {
          ...(makeLinkPost().link_enrichment_snapshot_json as Record<string, unknown>),
          source_language: null,
        },
        source_language: "fr",
      }),
      "es",
    )
    const result = serializeLocalizedPostResponse(response, { surface: "home_feed" })
    const enrichment = result.post.link_enrichment as Record<string, unknown> | null
    const translations = enrichment!.translations as Record<string, unknown>
    const translationKeys = Object.keys(translations)
    expect(translationKeys).toContain("es")
    expect(translationKeys).toContain("fr")
    expect(translationKeys).not.toContain("de")
    expect(translationKeys).not.toContain("ja")
  })
})
