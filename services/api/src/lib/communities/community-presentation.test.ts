import { describe, expect, test } from "bun:test"
import {
  assertCommunityPresentationPatch,
  communityPresentationFromRow,
} from "./community-presentation"

const current = communityPresentationFromRow({
  branding_json: "{}",
  default_surface: "threads",
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
    }, current)).toEqual({
      branding: {
        accent_color: "#767676",
        header_style: "immersive",
        tagline: "Community video, independently published.",
        theme: "system",
      },
      default_surface: "videos",
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
    })).toEqual(current)
  })
})
