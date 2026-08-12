import { describe, expect, test } from "bun:test"

import type { Post } from "../../types"
import {
  deferPostPublicationForListing,
  POST_LISTING_RECOVERY_MIN_AGE_MS,
  shouldResumePostListingDraft,
  syncRetriedPostProjection,
} from "./post-service"

describe("syncRetriedPostProjection", () => {
  test("updates projection status and payload to processing after retry", async () => {
    const calls: Array<{ input: Record<string, unknown>; method: string }> = []
    const post = {
      post_id: "pst_retry",
      status: "processing",
      publish_failure_code: null,
      publish_failure_message: null,
      publish_failure_retryable: null,
      publish_failed_at: null,
    } as unknown as Post

    await syncRetriedPostProjection({
      communityRepository: {
        async updateCommunityPostProjectionStatus(input) {
          calls.push({ method: "status", input })
        },
        async updateCommunityPostProjectionPayload(input) {
          calls.push({ method: "payload", input })
        },
      },
      post,
      updatedAt: "2026-07-05T12:00:00.000Z",
    })

    expect(calls).toEqual([
      {
        method: "status",
        input: {
          postId: "pst_retry",
          status: "processing",
          updatedAt: "2026-07-05T12:00:00.000Z",
        },
      },
      {
        method: "payload",
        input: {
          postId: "pst_retry",
          projectedPayloadJson: JSON.stringify(post),
          updatedAt: "2026-07-05T12:00:00.000Z",
        },
      },
    ])
  })
})

describe("shouldResumePostListingDraft", () => {
  const nowMs = Date.parse("2026-08-11T00:00:00.000Z")

  test("resumes listing failures and interrupted synchronous processing", () => {
    expect(shouldResumePostListingDraft({
      post: {
        status: "failed",
        publish_failure_code: "listing_creation_failed",
        asset_id: "ast_video",
        created_at: new Date(nowMs).toISOString(),
      },
      hasListingDraft: true,
    })).toBe(true)
    expect(shouldResumePostListingDraft({
      post: {
        status: "processing",
        publish_failure_code: null,
        asset_id: "ast_video",
        created_at: new Date(nowMs - POST_LISTING_RECOVERY_MIN_AGE_MS).toISOString(),
      },
      hasListingDraft: true,
      nowMs,
    })).toBe(true)
    expect(shouldResumePostListingDraft({
      post: {
        status: "processing",
        publish_failure_code: null,
        asset_id: "ast_song",
        created_at: new Date(nowMs - POST_LISTING_RECOVERY_MIN_AGE_MS).toISOString(),
      },
      hasListingDraft: true,
      publishMode: "async",
      nowMs,
    })).toBe(false)
    expect(shouldResumePostListingDraft({
      post: {
        status: "deleted",
        publish_failure_code: null,
        asset_id: "ast_video",
        created_at: new Date(nowMs - POST_LISTING_RECOVERY_MIN_AGE_MS).toISOString(),
      },
      hasListingDraft: true,
      nowMs,
    })).toBe(false)
  })

  test("does not race an in-flight processing request", () => {
    const recentCreatedAt = new Date(nowMs - POST_LISTING_RECOVERY_MIN_AGE_MS + 1).toISOString()
    const staleCreatedAt = new Date(nowMs - POST_LISTING_RECOVERY_MIN_AGE_MS).toISOString()

    expect(shouldResumePostListingDraft({
      post: {
        status: "processing",
        publish_failure_code: null,
        asset_id: "ast_video",
        created_at: recentCreatedAt,
      },
      hasListingDraft: true,
      nowMs,
    })).toBe(false)

    expect(shouldResumePostListingDraft({
      post: {
        status: "processing",
        publish_failure_code: null,
        asset_id: "ast_video",
        created_at: staleCreatedAt,
      },
      hasListingDraft: true,
      nowMs,
    })).toBe(true)

    expect(shouldResumePostListingDraft({
      post: {
        status: "processing",
        publish_failure_code: null,
        asset_id: "ast_video",
        created_at: "not-a-timestamp",
      },
      hasListingDraft: true,
      nowMs,
    })).toBe(false)
  })
})

describe("deferPostPublicationForListing", () => {
  test("keeps paid posts non-public until the listing is ready", () => {
    const publishedOverride = {
      analysis_state: "allow",
      content_safety_state: "safe",
      age_gate_policy: "none",
      status: "published",
    } as const
    const reviewOverride = {
      ...publishedOverride,
      analysis_state: "review_required",
      status: "draft",
    } as const

    expect(deferPostPublicationForListing(publishedOverride, true).status).toBe("processing")
    expect(deferPostPublicationForListing(publishedOverride, false).status).toBe("published")
    expect(deferPostPublicationForListing(reviewOverride, true).status).toBe("draft")
  })
})
