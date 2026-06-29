import { describe, expect, test } from "bun:test"
import { mockFetch } from "../../test-helpers/fetch"
import { resolveComposerLinkPreview } from "./link-embed-preview"

describe("resolveComposerLinkPreview", () => {
  test("returns generic link preview for non-embed URLs", async () => {
    const result = await resolveComposerLinkPreview({
      url: "https://example.com/article",
      fetcher: mockFetch(async () => new Response(`
        <meta property="og:title" content="Article Title">
        <meta property="og:image" content="https://example.com/image.jpg">
      `, { headers: { "content-type": "text/html" } })),
    })

    expect(result).toMatchObject({
      kind: "link",
      provider: null,
      title: "Article Title",
      imageUrl: "https://example.com/image.jpg",
    })
  })

  test("returns null when generic link has no metadata", async () => {
    const result = await resolveComposerLinkPreview({
      url: "https://example.com/empty",
      fetcher: mockFetch(async () => new Response("<html></html>", { headers: { "content-type": "text/html" } })),
    })

    expect(result).toBeNull()
  })

  test("returns embed preview for X posts", async () => {
    const result = await resolveComposerLinkPreview({
      url: "https://x.com/assalrad/status/2051291091685757231",
      fetcher: mockFetch(async (input) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url.includes("publish.x.com/oembed")) {
          return new Response(JSON.stringify({
            html: `<blockquote class="twitter-tweet"><p>Tweet text here</p></blockquote>`,
            author_name: "Assal Rad",
            author_url: "https://x.com/assalrad",
            cache_age: 3600,
          }), { headers: { "content-type": "application/json" } })
        }
        return new Response(`
          <meta property="og:title" content="X Post">
          <meta property="og:image" content="https://pic.x.com/media.jpg">
        `, { headers: { "content-type": "text/html" } })
      }),
    })

    expect(result).toMatchObject({
      kind: "embed",
      provider: "x",
      state: "embed",
      title: "Tweet text here",
      preview: {
        author_name: "Assal Rad",
        text: "Tweet text here",
        has_media: true,
        media_url: "https://pic.x.com/media.jpg",
      },
    })
  })

  test("returns unavailable X embed when oembed fails but fallback works", async () => {
    const result = await resolveComposerLinkPreview({
      url: "https://x.com/user/status/123",
      fetcher: mockFetch(async (input) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url.includes("publish.x.com/oembed")) {
          return new Response("Not found", { status: 404 })
        }
        return new Response(`
          <meta property="og:title" content="Fallback Title">
        `, { headers: { "content-type": "text/html" } })
      }),
    })

    expect(result).toMatchObject({
      kind: "embed",
      provider: "x",
      state: "unavailable",
      title: "Fallback Title",
      preview: {
        text: "Fallback Title",
      },
    })
  })

  test("returns embed preview for YouTube videos", async () => {
    const result = await resolveComposerLinkPreview({
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      fetcher: mockFetch(async (input) => {
        const url = input instanceof Request ? input.url : String(input)
        if (url.includes("youtube.com/oembed")) {
          return new Response(JSON.stringify({
            title: "Rick Astley - Never Gonna Give You Up",
            author_name: "Rick Astley",
            author_url: "https://www.youtube.com/@RickAstley",
            thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
            thumbnail_width: 480,
            thumbnail_height: 360,
            html: `<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>`,
          }), { headers: { "content-type": "application/json", "cache-control": "max-age=7200" } })
        }
        return new Response("", { status: 404 })
      }),
    })

    expect(result).toMatchObject({
      kind: "embed",
      provider: "youtube",
      state: "embed",
      title: "Rick Astley - Never Gonna Give You Up",
      preview: {
        title: "Rick Astley - Never Gonna Give You Up",
        author_name: "Rick Astley",
        thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg",
      },
    })
  })

  test("returns generic link preview for Kalshi URLs", async () => {
    const result = await resolveComposerLinkPreview({
      url: "https://kalshi.com/markets/us-election",
      fetcher: mockFetch(async () => new Response(`
        <meta property="og:title" content="Election Market">
        <meta property="og:image" content="https://kalshi.com/image.jpg">
      `, { headers: { "content-type": "text/html" } })),
    })

    expect(result).toMatchObject({
      kind: "link",
      provider: "kalshi",
      title: "Election Market",
      imageUrl: "https://kalshi.com/image.jpg",
    })
  })
})
