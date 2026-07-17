import { describe, expect, test } from "bun:test"

import { isOperatorBlockedPostPublish } from "./operator-blocked-publish-recovery"

const post = {
  asset_id: "ast_song",
  post_id: "pst_song",
  publish_failure_code: "story_royalty_registration_failed" as const,
  status: "failed" as const,
}

describe("isOperatorBlockedPostPublish", () => {
  test("accepts only a matching asset whose Story failure is insufficient funding", () => {
    expect(isOperatorBlockedPostPublish({
      post,
      asset: {
        asset_id: "ast_song",
        source_post_id: "pst_song",
        story_error: "royalty_registration_failed:Story runtime signer funding below floor: redacted",
      },
    })).toBe(true)
  })

  test("rejects transient failures and mismatched assets", () => {
    expect(isOperatorBlockedPostPublish({
      post,
      asset: { asset_id: "ast_song", source_post_id: "pst_song", story_error: "RPC Request failed" },
    })).toBe(false)
    expect(isOperatorBlockedPostPublish({
      post,
      asset: { asset_id: "ast_other", source_post_id: "pst_song", story_error: "insufficient funds" },
    })).toBe(false)
  })
})
