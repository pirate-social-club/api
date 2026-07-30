import { describe, expect, test } from "bun:test"
import type { Post } from "../../types"
import {
  assertTelegramSyntheticCleanupPost,
  TELEGRAM_SYNTHETIC_BODY,
  TELEGRAM_SYNTHETIC_TITLE_PREFIX,
} from "./telegram-synthetic-contract"

const NOW = Date.parse("2026-07-30T00:30:00.000Z")
const syntheticPost = {
  post_id: "pst_synthetic",
  community_id: "cmt_fixture",
  author_user_id: "usr_owner",
  status: "published",
  visibility: "public",
  title: `${TELEGRAM_SYNTHETIC_TITLE_PREFIX}1785369600000`,
  body: TELEGRAM_SYNTHETIC_BODY,
  created_at: "2026-07-30T00:00:00.000Z",
} as Post

describe("Telegram synthetic cleanup contract", () => {
  test("accepts only the recent post shape created by the synthetic", () => {
    expect(() => assertTelegramSyntheticCleanupPost({
      post: syntheticPost,
      communityId: "cmt_fixture",
      ownerUserId: "usr_owner",
      nowMs: NOW,
    })).not.toThrow()
  })

  test.each([
    ["another title", { title: "A normal community post" }],
    ["another body", { body: "Normal content" }],
    ["another author", { author_user_id: "usr_other" }],
    ["another community", { community_id: "cmt_other" }],
    ["non-public visibility", { visibility: "members_only" }],
    ["deleted state", { status: "deleted" }],
    ["an old post", { created_at: "2026-07-29T22:00:00.000Z" }],
  ])("rejects %s", (_label, override) => {
    expect(() => assertTelegramSyntheticCleanupPost({
      post: { ...syntheticPost, ...override } as Post,
      communityId: "cmt_fixture",
      ownerUserId: "usr_owner",
      nowMs: NOW,
    })).toThrow("restricted to a recent synthetic post")
  })
})
