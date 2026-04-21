import { describe, expect, test } from "bun:test"
import { extractLinkPreviewMetadata, fetchLinkPreviewMetadata } from "./link-preview-fetcher"

describe("link-preview-fetcher", () => {
  test("extracts and resolves og:image from html", async () => {
    const metadata = await extractLinkPreviewMetadata({
      pageUrl: "https://example.com/articles/story",
      response: new Response(`
        <html>
          <head>
            <meta property="og:image" content="/images/preview.jpg">
          </head>
        </html>
      `, {
        headers: {
          "content-type": "text/html",
        },
      }),
    })

    expect(metadata.imageUrl).toBe("https://example.com/images/preview.jpg")
  })

  test("does not return non-http preview image urls", async () => {
    const metadata = await extractLinkPreviewMetadata({
      pageUrl: "https://example.com/articles/story",
      response: new Response(`
        <meta property="og:image" content="data:image/png;base64,abc">
      `, {
        headers: {
          "content-type": "text/html",
        },
      }),
    })

    expect(metadata.imageUrl).toBeNull()
  })

  test("fetches html with a bounded timeout", async () => {
    const requestedUrls: string[] = []
    const metadata = await fetchLinkPreviewMetadata({
      url: "https://example.com/post",
      fetcher: (async (input) => {
        requestedUrls.push(input instanceof Request ? input.url : String(input))
        return new Response('<meta property="og:image" content="https://cdn.example.com/post.jpg">', {
          headers: {
            "content-type": "text/html",
          },
        })
      }) as typeof fetch,
      timeoutMs: 1_000,
    })

    expect(requestedUrls).toEqual(["https://example.com/post"])
    expect(metadata.imageUrl).toBe("https://cdn.example.com/post.jpg")
  })
})
