import { describe, expect, test } from "bun:test"

import type { Post } from "../../types"
import { shouldHidePostForMissingAsset } from "./post-access"

function post(input: {
  assetId?: string | null
  assetStory?: Post["asset_story"]
  postType?: Post["post_type"]
  status: Post["status"]
}): Pick<Post, "asset_id" | "asset_story" | "post_type" | "status"> {
  return {
    asset_id: input.assetId ?? "ast_missing",
    asset_story: input.assetStory ?? null,
    post_type: input.postType ?? "song",
    status: input.status,
  }
}

describe("shouldHidePostForMissingAsset", () => {
  test("hides published asset-backed posts without an asset row", () => {
    expect(shouldHidePostForMissingAsset(post({ status: "published" }))).toBe(true)
  })

  test("keeps non-published async publish posts readable for author-scoped surfaces", () => {
    expect(shouldHidePostForMissingAsset(post({ status: "processing" }))).toBe(false)
    expect(shouldHidePostForMissingAsset(post({ status: "failed" }))).toBe(false)
  })

  test("does not hide posts when an asset row is present or the post is not asset-backed", () => {
    expect(shouldHidePostForMissingAsset(post({
      status: "published",
      assetStory: { story_royalty_registration_status: "none" } as Post["asset_story"],
    }))).toBe(false)
    expect(shouldHidePostForMissingAsset(post({
      status: "published",
      postType: "text",
    }))).toBe(false)
  })
})
