import { describe, expect, test } from "bun:test"

import type { LocalizedPostResponse } from "../../types"
import {
  homeFeedVideoDerivativeResponses,
  summarizeHomeFeedCommunityPhaseTimings,
  type HomeFeedCommunityTiming,
} from "./home-feed-community-reader"

function response(input: {
  postType: "text" | "video"
  refs?: string[] | null
}): LocalizedPostResponse {
  return {
    post: {
      post_type: input.postType,
      upstream_asset_refs: input.refs ?? null,
    },
  } as LocalizedPostResponse
}

describe("homeFeedVideoDerivativeResponses", () => {
  test("selects only videos that declare upstream sources", () => {
    const linkedVideo = response({ postType: "video", refs: ["story:ip:0x123#licenseTermsId=1"] })
    const plainVideo = response({ postType: "video" })
    const linkedText = response({ postType: "text", refs: ["story:ip:0x123#licenseTermsId=1"] })

    expect(homeFeedVideoDerivativeResponses([linkedVideo, plainVideo, linkedText])).toEqual([linkedVideo])
  })
})

function communityTiming(overrides: Partial<HomeFeedCommunityTiming>): HomeFeedCommunityTiming {
  return {
    community_id: "cmt_timing",
    rows: 1,
    returned_items: 1,
    total_ms: 0,
    open_ms: 0,
    identity_ms: 0,
    batched_reads_ms: 0,
    localize_ms: 0,
    crosspost_ms: 0,
    author_handles_ms: 0,
    streaks_ms: 0,
    derivatives_ms: 0,
    derivative_local_rows_ms: 0,
    derivative_global_rows_ms: 0,
    derivative_profiles_ms: 0,
    derivative_profiles_degraded: false,
    serialize_ms: 0,
    enqueue_ms: 0,
    unaccounted_ms: 0,
    ...overrides,
  }
}

describe("summarizeHomeFeedCommunityPhaseTimings", () => {
  test("reports sum and critical-path maximum for probe-visible hydration phases", () => {
    const result = summarizeHomeFeedCommunityPhaseTimings([
      communityTiming({
        total_ms: 100,
        open_ms: 20,
        batched_reads_ms: 30,
        localize_ms: 12,
        streaks_ms: 8,
        derivatives_ms: 6,
        unaccounted_ms: 24,
      }),
      communityTiming({
        total_ms: 160,
        open_ms: 50,
        batched_reads_ms: 25,
        localize_ms: 18,
        streaks_ms: 11,
        derivatives_ms: 9,
        unaccounted_ms: 47,
      }),
    ])

    expect(result).toEqual({
      community_total_sum_ms: 260,
      community_total_max_ms: 160,
      community_open_sum_ms: 70,
      community_open_max_ms: 50,
      community_batched_reads_sum_ms: 55,
      community_batched_reads_max_ms: 30,
      community_localize_sum_ms: 30,
      community_localize_max_ms: 18,
      community_streaks_sum_ms: 19,
      community_streaks_max_ms: 11,
      community_derivatives_sum_ms: 15,
      community_derivatives_max_ms: 9,
      community_unaccounted_sum_ms: 71,
      community_unaccounted_max_ms: 47,
    })
  })
})
