import { describe, expect, test } from "bun:test"

import type { LocalizedPostResponse } from "../../types"
import { homeFeedVideoDerivativeResponses } from "./home-feed-community-reader"

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
