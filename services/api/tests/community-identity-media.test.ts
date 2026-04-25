import { describe, expect, test } from "bun:test"
import {
  buildDefaultCommunityAvatarRef,
  buildDefaultCommunityBannerRef,
} from "../src/lib/communities/community-identity-media"

describe("community identity media", () => {
  test("builds default media for emoji display names", () => {
    expect(() => buildDefaultCommunityAvatarRef({
      communityId: "cmt_palestine",
      displayName: "🇵🇸",
    })).not.toThrow()

    expect(() => buildDefaultCommunityBannerRef({
      communityId: "cmt_palestine",
      displayName: "🇵🇸",
    })).not.toThrow()
  })

  test("replaces malformed surrogate display-name text before URI encoding", () => {
    const avatarRef = buildDefaultCommunityAvatarRef({
      communityId: "cmt_bad_surrogate",
      displayName: "\uD83C",
    })

    expect(avatarRef.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true)
    expect(decodeURIComponent(avatarRef.slice("data:image/svg+xml;charset=utf-8,".length))).toContain("\uFFFD")
  })
})
