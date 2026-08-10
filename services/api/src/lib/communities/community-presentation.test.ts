import { describe, expect, test } from "bun:test"
import {
  assertCommunityPresentationPatch,
  communityPresentationFromRow,
} from "./community-presentation"

const current = communityPresentationFromRow({
  branding_json: "{}",
  default_surface: "threads",
  video_feed_enabled: true,
})

describe("community presentation", () => {
  test("merges and normalizes a constrained presentation patch", () => {
    expect(assertCommunityPresentationPatch({
      branding: {
        accent_color: "#767676",
        header_style: "immersive",
        tagline: "  Community video, independently published.  ",
      },
      default_surface: "videos",
      video_feed_enabled: true,
    }, current)).toEqual({
      branding: {
        accent_color: "#767676",
        header_style: "immersive",
        tagline: "Community video, independently published.",
        theme: "system",
      },
      default_surface: "videos",
      video_feed_enabled: true,
    })
  })

  test("rejects unknown fields and unsafe accent contrast", () => {
    expect(() => assertCommunityPresentationPatch({
      branding: { custom_css: "body{display:none}" },
    } as never, current)).toThrow("Unknown branding field: custom_css")

    expect(() => assertCommunityPresentationPatch({
      branding: { accent_color: "#FFFFFF", theme: "light" },
    }, current)).toThrow("must meet 3:1 contrast")
  })

  test("normalizes malformed stored presentation fail-closed", () => {
    expect(communityPresentationFromRow({
      branding_json: JSON.stringify({
        accent_color: "javascript:alert(1)",
        header_style: "arbitrary",
        tagline: 42,
        theme: "arbitrary",
      }),
      default_surface: "threads",
      video_feed_enabled: true,
    })).toEqual(current)
  })

  test("atomically resets a video default when the video feed is disabled", () => {
    expect(assertCommunityPresentationPatch({ video_feed_enabled: false }, {
      ...current,
      default_surface: "videos",
    })).toEqual({
      ...current,
      default_surface: "threads",
      video_feed_enabled: false,
    })
    expect(() => assertCommunityPresentationPatch({
      default_surface: "videos",
      video_feed_enabled: false,
    }, current)).toThrow("default_surface cannot be videos")
  })
})
