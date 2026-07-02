import { describe, expect, test } from "bun:test"
import { extractLinkPreviewMetadata, fetchLinkPreviewMetadata, isBlockedSsrfHostname } from "./link-preview-fetcher"

describe("isBlockedSsrfHostname (SSRF guard)", () => {
  test("blocks private, loopback, link-local, CGNAT, and internal hosts", () => {
    for (const host of [
      "127.0.0.1", "10.0.0.5", "192.168.1.1", "172.16.0.1", "172.31.255.255",
      "169.254.169.254", "100.64.0.1", "0.0.0.0", "localhost", "metadata",
      "foo.internal", "printer.local", "::1", "fe80::1", "fd00::1", "[::1]",
    ]) {
      expect(isBlockedSsrfHostname(host)).toBe(true)
    }
  })
  test("allows normal public hosts (incl. public IPs just outside private ranges)", () => {
    for (const host of [
      "example.com", "www.youtube.com", "8.8.8.8", "sub.domain.co.uk",
      "172.15.0.1", "172.32.0.1", "11.0.0.1",
    ]) {
      expect(isBlockedSsrfHostname(host)).toBe(false)
    }
  })
})

describe("fetchLinkPreviewMetadata SSRF enforcement", () => {
  test("never fetches a directly-private URL", async () => {
    let called = false
    const result = await fetchLinkPreviewMetadata({
      url: "http://127.0.0.1:8080/admin",
      fetcher: (async () => { called = true; return new Response("x") }) as typeof fetch,
    })
    expect(called).toBe(false)
    expect(result).toEqual({ imageUrl: null, title: null })
  })

  test("does not follow a redirect to a private/metadata target", async () => {
    let calls = 0
    const result = await fetchLinkPreviewMetadata({
      url: "https://public.example.com/start",
      fetcher: (async () => {
        calls += 1
        if (calls === 1) {
          return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } })
        }
        return new Response("<html><head><title>secret</title></head></html>", { headers: { "content-type": "text/html" } })
      }) as typeof fetch,
    })
    expect(result).toEqual({ imageUrl: null, title: null })
    expect(calls).toBe(1) // stopped at the redirect; never fetched the internal target
  })
})

describe("link-preview-fetcher", () => {
  test("extracts and resolves Open Graph preview metadata from html", async () => {
    const metadata = await extractLinkPreviewMetadata({
      pageUrl: "https://example.com/articles/story",
      response: new Response(`
        <html>
          <head>
            <meta property="og:title" content="Story &amp; production notes">
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
    expect(metadata.title).toBe("Story & production notes")
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
    expect(metadata.title).toBeNull()
  })

  test("falls back to document title when og title is missing", async () => {
    const metadata = await extractLinkPreviewMetadata({
      pageUrl: "https://example.com/articles/story",
      response: new Response(`
        <html>
          <head>
            <title>
              Example Story
            </title>
          </head>
        </html>
      `, {
        headers: {
          "content-type": "text/html",
        },
      }),
    })

    expect(metadata.title).toBe("Example Story")
  })

  test("fetches html with a bounded timeout", async () => {
    const requestedUrls: string[] = []
    const metadata = await fetchLinkPreviewMetadata({
      url: "https://example.com/post",
      fetcher: (async (input) => {
        requestedUrls.push(input instanceof Request ? input.url : String(input))
        return new Response(`
          <meta property="og:title" content="Fetched post title">
          <meta property="og:image" content="https://cdn.example.com/post.jpg">
        `, {
          headers: {
            "content-type": "text/html",
          },
        })
      }) as typeof fetch,
      timeoutMs: 1_000,
    })

    expect(requestedUrls).toEqual(["https://example.com/post"])
    expect(metadata.imageUrl).toBe("https://cdn.example.com/post.jpg")
    expect(metadata.title).toBe("Fetched post title")
  })
})
