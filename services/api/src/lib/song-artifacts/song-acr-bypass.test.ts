import { describe, expect, test } from "bun:test"
import { shouldSkipSongAcr } from "./song-acr-bypass"

describe("shouldSkipSongAcr", () => {
  test("skips in non-production for an allowlisted raw community id", () => {
    expect(shouldSkipSongAcr({
      env: {
        ENVIRONMENT: "staging",
        SONG_ACR_BYPASS_COMMUNITY_IDS: "cmt_test_1,cmt_test_2",
      },
      communityId: "cmt_test_2",
    })).toBe(true)
  })

  test("accepts public community ids in the allowlist", () => {
    expect(shouldSkipSongAcr({
      env: {
        ENVIRONMENT: "staging",
        SONG_ACR_BYPASS_COMMUNITY_IDS: "com_cmt_public",
      },
      communityId: "cmt_public",
    })).toBe(true)
  })

  test("does not skip in production even when the community is allowlisted", () => {
    expect(shouldSkipSongAcr({
      env: {
        ENVIRONMENT: "production",
        SONG_ACR_BYPASS_COMMUNITY_IDS: "com_cmt_public",
      },
      communityId: "cmt_public",
    })).toBe(false)
  })

  test("does not skip for non-allowlisted communities", () => {
    expect(shouldSkipSongAcr({
      env: {
        ENVIRONMENT: "staging",
        SONG_ACR_BYPASS_COMMUNITY_IDS: "com_cmt_allowed",
      },
      communityId: "cmt_other",
    })).toBe(false)
  })
})
