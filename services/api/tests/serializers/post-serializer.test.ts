import { describe, expect, test } from "bun:test"
import { serializeLocalizedPostResponse, serializePost } from "../../src/serializers/post"
import { serializeProfileActivityResponse } from "../../src/serializers/profile-activity"
import { resolveAgeGateViewerState } from "../../src/lib/posts/age-gate-viewer-state"
import { buildDefaultVerificationCapabilities } from "../../src/lib/verification/verification-capabilities"
import type { UserRepository } from "../../src/lib/auth/repositories"
import type { LocalizedPostResponse, Post, ProfileActivityResponse, User } from "../../src/types"

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

function makeProofRequiredVideoResponse(): LocalizedPostResponse {
  const response = makeLocalizedResponse(makeLinkPost({
    post_type: "video",
    age_gate_policy: "18_plus",
    content_safety_state: "adult",
    media_refs: [{
      storage_ref: "https://media.test/adult-video.mp4",
      poster_ref: "https://media.test/adult-poster.jpg",
      mime_type: "video/mp4",
    }],
  }), "en")
  response.age_gate_viewer_state = "proof_required"
  return response
}

function expectNoAdultMedia(value: unknown): void {
  const json = JSON.stringify(value)
  expect(json).not.toContain("media_refs")
  expect(json).not.toContain("adult-video.mp4")
  expect(json).not.toContain("adult-poster.jpg")
}

describe("serializeLocalizedPostResponse feed pruning", () => {
  test("omits video media and poster refs when age proof is required", () => {
    const response = makeProofRequiredVideoResponse()

    const result = serializeLocalizedPostResponse(response)

    expectNoAdultMedia(result)
    expect(result.age_gate_viewer_state).toBe("proof_required")
  })

  test("omits age-gated media from the home-feed payload", () => {
    expectNoAdultMedia(serializeLocalizedPostResponse(makeProofRequiredVideoResponse(), { surface: "home_feed" }))
  })

  test("omits age-gated media for an authenticated but age-unverified viewer", async () => {
    const user = {
      user_id: "usr_unverified",
      verification_state: "unverified",
      verification_capabilities: buildDefaultVerificationCapabilities(),
      created_at: "2026-05-15T00:00:00.000Z",
      updated_at: "2026-05-15T00:00:00.000Z",
    } as User
    const userRepository = {
      getUserById: async () => user,
    } as unknown as UserRepository
    const response = makeProofRequiredVideoResponse()
    response.age_gate_viewer_state = await resolveAgeGateViewerState({
      userId: user.user_id,
      userRepository,
      postAgeGatePolicy: "18_plus",
    })

    expect(response.age_gate_viewer_state).toBe("proof_required")
    expectNoAdultMedia(serializeLocalizedPostResponse(response))
  })

  test("omits age-gated media from profile-activity payloads", () => {
    const post = makeProofRequiredVideoResponse()
    const response = {
      tab: "posts",
      posts: [{
        kind: "post",
        post,
        community: {
          community_id: "cmt_test",
          display_name: "Test",
          membership_mode: "open",
          karaoke_enabled: true,
          human_verification_lane: "none",
          moderators: [],
          membership_gate_summaries: [],
        },
        created_at: "2026-05-15T00:00:00.000Z",
      }],
      comments: [],
      overview_items: [],
      next_cursor: null,
    } as unknown as ProfileActivityResponse

    expectNoAdultMedia(serializeProfileActivityResponse(response))
  })

  test("keeps media for warning-only sensitive content", () => {
    const response = makeLocalizedResponse(makeLinkPost({
      post_type: "video",
      content_safety_state: "sensitive",
      age_gate_policy: "none",
      media_refs: [{
        storage_ref: "https://media.test/sensitive-video.mp4",
        poster_ref: "https://media.test/sensitive-poster.jpg",
        mime_type: "video/mp4",
      }],
    }), "en")

    const result = serializeLocalizedPostResponse(response)

    expect(result.post.media_refs).toHaveLength(1)
    expect(result.post.media_refs?.[0]?.poster_ref).toBe("https://media.test/sensitive-poster.jpg")
  })

  test("post serializer includes public live room status snapshot", () => {
    const result = serializePost(makeLinkPost({
      anchor_live_room_id: "lr_test",
      anchor_live_room_status: "live",
    }))

    expect(result.anchor_live_room).toBe("lr_test")
    expect(result.anchor_live_room_status).toBe("live")
  })

  test("post serializer exposes publish failure timestamp", () => {
    const result = serializePost(makeLinkPost({
      publish_failure_code: "internal_error",
      publish_failure_message: "Finalize failed",
      publish_failure_retryable: true,
      publish_failed_at: "2026-07-06T19:00:00.000Z",
      status: "failed",
    }))

    expect(result.publish_failure_code).toBe("internal_error")
    expect(result.publish_failure_message).toBe("Finalize failed")
    expect(result.publish_failure_retryable).toBe(true)
    expect(result.publish_failed_at).toBe(Date.parse("2026-07-06T19:00:00.000Z") / 1000)
  })

  test("localized post serializer exposes asset Story summary", () => {
    const response = makeLocalizedResponse(makeLinkPost(), "en")
    response.asset_story = {
      story_ip: "0xbB0a33bd07e7c813963b569f1202047a92b38d48",
      story_royalty_registration_status: "registered",
    }

    const result = serializeLocalizedPostResponse(response)

    expect(result.asset_story).toEqual({
      story_ip: "0xbB0a33bd07e7c813963b569f1202047a92b38d48",
      story_royalty_registration_status: "registered",
    })
  })

  test("localized post serializer exposes study capability summary", () => {
    const response = makeLocalizedResponse(makeLinkPost({ post_type: "song" }), "en")
    response.study_capability = {
      status: "ready",
      exercise_count: 12,
      source_language: "en",
      target_language: "es",
    }

    const result = serializeLocalizedPostResponse(response)

    expect(result.study_capability).toEqual({
      status: "ready",
      exercise_count: 12,
      source_language: "en",
      target_language: "es",
    })
  })

  test("localized post serializer exposes streak summary", () => {
    const response = makeLocalizedResponse(makeLinkPost({ post_type: "song" }), "en")
    response.streak_summary = {
      entries: [{
        best_streak: 23,
        current_streak: 21,
        identity: {
          avatar_ref: null,
          display_name: "lena.pirate",
          handle: "lena.pirate",
          user_id: "usr_lena",
        },
        is_viewer: false,
        last_qualified_date: "2026-07-06",
        rank: 1,
        streak_started_date: "2026-06-16",
        total_qualified_days: 26,
      }],
      total_active_streaks: 5,
      viewer: {
        alive: true,
        best_streak: 14,
        current_streak: 14,
        karaoke_passed_today: false,
        qualified_today: false,
        study_attempts_today: 6,
        study_target_today: 10,
        total_qualified_days: 19,
      },
    }

    const result = serializeLocalizedPostResponse(response)

    expect(result.streak_summary).toEqual(response.streak_summary)
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
