import { describe, expect, test } from "bun:test"
import {
  eligibleTelegramPost,
  renderTelegramPostCaption,
  renderTelegramPostText,
  telegramPublicationMedia,
} from "./channel-publishing-service"

describe("Telegram channel post rendering", () => {
  test("renders canonical post copy and link", () => {
    const post = {
      title: "Release",
      caption: "Watch the new video",
      body: "Made on Pirate",
      link_url: "https://example.com/source",
    }
    expect(renderTelegramPostCaption(post)).toBe("Release\n\nWatch the new video\n\nMade on Pirate")
    expect(renderTelegramPostText(post)).toEndWith("https://example.com/source")
  })

  test("uses only a locked post preview", () => {
    expect(telegramPublicationMedia({
      access_mode: "locked",
      media_refs: [{
        storage_ref: "https://cdn.example/full.mp4",
        preview_storage_ref: "https://cdn.example/preview.mp4",
        mime_type: "video/mp4",
      }],
    })).toEqual({
      kind: "video",
      url: "https://cdn.example/preview.mp4",
    })
  })

  test("rejects private and adult projections", () => {
    const projection = {
      status: "published",
      visibility: "public",
    } as Parameters<typeof eligibleTelegramPost>[0]
    expect(eligibleTelegramPost(projection, {
      status: "published",
      visibility: "public",
      age_gate_policy: "18_plus",
    })).toBe(false)
    expect(eligibleTelegramPost({
      ...projection,
      visibility: "members_only",
    }, {
      status: "published",
      visibility: "members_only",
    })).toBe(false)
  })
})
