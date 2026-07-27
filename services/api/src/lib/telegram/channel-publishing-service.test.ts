import { describe, expect, test } from "bun:test"
import {
  eligibleTelegramPost,
  renderTelegramPostCaption,
  renderTelegramPostText,
  telegramPublicationMedia,
  TELEGRAM_URL_PHOTO_MAX_BYTES,
  TELEGRAM_URL_VIDEO_MAX_BYTES,
} from "./channel-publishing-service"

// These fixtures mirror the descriptors written by post-create-asset-preparation.
// An earlier revision asserted a `preview_storage_ref` field that does not exist
// on a real media ref, so the suite passed while locked posts silently degraded
// to text-only in production. Keep these shapes in step with the writers.
function videoRef(overrides: Record<string, unknown> = {}) {
  return {
    storage_ref: "https://cdn.example/full.mp4",
    mime_type: "video/mp4",
    size_bytes: 4_000_000,
    poster_ref: "https://cdn.example/poster.jpg",
    poster_mime_type: "image/jpeg",
    poster_size_bytes: 120_000,
    ...overrides,
  }
}

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

  test("sends the full asset for an unlocked post", () => {
    expect(telegramPublicationMedia({ media_refs: [videoRef()] })).toEqual({
      kind: "video",
      url: "https://cdn.example/full.mp4",
    })
  })

  test("uses the preview clip for a locked post, never the full asset", () => {
    expect(telegramPublicationMedia({
      access_mode: "locked",
      media_refs: [videoRef({
        preview_video: {
          storage_ref: "https://cdn.example/preview.mp4",
          mime_type: "video/mp4",
          size_bytes: 900_000,
        },
      })],
    })).toEqual({
      kind: "video",
      url: "https://cdn.example/preview.mp4",
    })
  })

  test("falls back to the poster still for a locked post with no preview clip", () => {
    expect(telegramPublicationMedia({
      access_mode: "locked",
      media_refs: [videoRef()],
    })).toEqual({
      kind: "photo",
      url: "https://cdn.example/poster.jpg",
    })
  })

  test("degrades a locked post with neither preview nor poster to text only", () => {
    expect(telegramPublicationMedia({
      access_mode: "locked",
      media_refs: [videoRef({ poster_ref: null })],
    })).toBeNull()
  })

  test("never leaks the full asset for a locked audio post", () => {
    // preview_audio has no photo/video send path, so it must fall through to
    // the poster rather than reaching for storage_ref.
    const media = telegramPublicationMedia({
      access_mode: "locked",
      media_refs: [{
        storage_ref: "https://cdn.example/full.mp3",
        mime_type: "audio/mpeg",
        poster_ref: "https://cdn.example/cover.jpg",
        poster_mime_type: "image/jpeg",
        poster_size_bytes: 90_000,
        preview_audio: {
          storage_ref: "https://cdn.example/preview.mp3",
          mime_type: "audio/mpeg",
          size_bytes: 400_000,
        },
      }],
    })
    expect(media).toEqual({ kind: "photo", url: "https://cdn.example/cover.jpg" })
  })
})

describe("Telegram by-URL upload ceilings", () => {
  test("falls back to the poster when the video exceeds the by-URL video ceiling", () => {
    expect(telegramPublicationMedia({
      media_refs: [videoRef({ size_bytes: TELEGRAM_URL_VIDEO_MAX_BYTES + 1 })],
    })).toEqual({
      kind: "photo",
      url: "https://cdn.example/poster.jpg",
    })
  })

  test("degrades to text when both the video and its poster are oversized", () => {
    expect(telegramPublicationMedia({
      media_refs: [videoRef({
        size_bytes: TELEGRAM_URL_VIDEO_MAX_BYTES + 1,
        poster_size_bytes: TELEGRAM_URL_PHOTO_MAX_BYTES + 1,
      })],
    })).toBeNull()
  })

  test("drops an oversized image rather than burning retries on a certain reject", () => {
    expect(telegramPublicationMedia({
      media_refs: [{
        storage_ref: "https://cdn.example/huge.png",
        mime_type: "image/png",
        size_bytes: TELEGRAM_URL_PHOTO_MAX_BYTES + 1,
      }],
    })).toBeNull()
  })

  test("still attempts a send when the size is unknown", () => {
    expect(telegramPublicationMedia({
      media_refs: [{
        storage_ref: "https://cdn.example/unknown.mp4",
        mime_type: "video/mp4",
        size_bytes: null,
      }],
    })).toEqual({
      kind: "video",
      url: "https://cdn.example/unknown.mp4",
    })
  })

  test("accepts an asset exactly at the ceiling", () => {
    expect(telegramPublicationMedia({
      media_refs: [videoRef({ size_bytes: TELEGRAM_URL_VIDEO_MAX_BYTES })],
    })).toEqual({
      kind: "video",
      url: "https://cdn.example/full.mp4",
    })
  })

  test("ignores non-https refs", () => {
    expect(telegramPublicationMedia({
      media_refs: [{
        storage_ref: "http://cdn.example/insecure.mp4",
        mime_type: "video/mp4",
      }],
    })).toBeNull()
  })
})

describe("Telegram channel eligibility", () => {
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
