import { describe, expect, test } from "bun:test"
import {
  MIRROR_REQUEST_HOST_HEADER,
  canonicalApiHostnames,
  mirrorResponseToRequestHost,
  resolveRequestMirrorOrigin,
} from "./request-host-mirror"

function jsonRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://api.pirate.sc/feed/home/public", { headers })
}

function jsonResponse(payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      ...headers,
    },
  })
}

describe("resolveRequestMirrorOrigin", () => {
  test("mirrors the allowlisted HNS hostname from the gateway header", () => {
    expect(resolveRequestMirrorOrigin(jsonRequest({
      [MIRROR_REQUEST_HOST_HEADER]: "api.pirate",
    }))).toBe("https://api.pirate")
  })

  test("falls back to the request Host header when the gateway header is absent", () => {
    expect(resolveRequestMirrorOrigin(jsonRequest({ host: "api.pirate" }))).toBe("https://api.pirate")
  })

  test("normalizes case, trailing dots, and ports before allowlisting", () => {
    expect(resolveRequestMirrorOrigin(jsonRequest({
      [MIRROR_REQUEST_HOST_HEADER]: "API.pirate.:443",
    }))).toBe("https://api.pirate")
  })

  test("returns null without a request host signal", () => {
    expect(resolveRequestMirrorOrigin(jsonRequest())).toBeNull()
  })

  test("never reflects unknown or hostile host values", () => {
    expect(resolveRequestMirrorOrigin(jsonRequest({
      [MIRROR_REQUEST_HOST_HEADER]: "evil.example",
    }))).toBeNull()
    expect(resolveRequestMirrorOrigin(jsonRequest({ host: "evil.example" }))).toBeNull()
    expect(resolveRequestMirrorOrigin(jsonRequest({
      [MIRROR_REQUEST_HOST_HEADER]: "api.pirate.evil.example",
    }))).toBeNull()
    expect(resolveRequestMirrorOrigin(jsonRequest({
      [MIRROR_REQUEST_HOST_HEADER]: "api.pirate.sc",
    }))).toBeNull()
    expect(resolveRequestMirrorOrigin(jsonRequest({
      [MIRROR_REQUEST_HOST_HEADER]: "https://api.pirate/x",
    }))).toBeNull()
  })

  test("uses only the first value of a comma-joined header", () => {
    expect(resolveRequestMirrorOrigin(jsonRequest({
      [MIRROR_REQUEST_HOST_HEADER]: "api.pirate, evil.example",
    }))).toBe("https://api.pirate")
    expect(resolveRequestMirrorOrigin(jsonRequest({
      [MIRROR_REQUEST_HOST_HEADER]: "evil.example, api.pirate",
    }))).toBeNull()
  })
})

describe("canonicalApiHostnames", () => {
  test("always includes the production canonical hostname", () => {
    expect(canonicalApiHostnames(undefined).has("api.pirate.sc")).toBe(true)
  })

  test("adds the configured public origin hostname", () => {
    const hostnames = canonicalApiHostnames({ PIRATE_API_PUBLIC_ORIGIN: "https://pirate-api-staging.example.dev" })
    expect(hostnames.has("pirate-api-staging.example.dev")).toBe(true)
    expect(hostnames.has("api.pirate.sc")).toBe(true)
  })

  test("ignores malformed or mirrorable configured origins", () => {
    expect(canonicalApiHostnames({ PIRATE_API_PUBLIC_ORIGIN: "not a url" }).has("api.pirate.sc")).toBe(true)
    const hostnames = canonicalApiHostnames({ PIRATE_API_PUBLIC_ORIGIN: "https://api.pirate" })
    expect(hostnames.has("api.pirate")).toBe(false)
  })
})

describe("mirrorResponseToRequestHost", () => {
  const env = {}

  test("returns the original response object when no allowlisted host is present", async () => {
    const response = jsonResponse({ storage_ref: "https://api.pirate.sc/community-media/avatar/avatar_x.jpg" })
    const result = await mirrorResponseToRequestHost({ request: jsonRequest(), response, env })
    expect(result).toBe(response)
  })

  test("returns the original response object for a hostile host header", async () => {
    const response = jsonResponse({ storage_ref: "https://api.pirate.sc/community-media/avatar/avatar_x.jpg" })
    const result = await mirrorResponseToRequestHost({
      request: jsonRequest({ [MIRROR_REQUEST_HOST_HEADER]: "evil.example" }),
      response,
      env,
    })
    expect(result).toBe(response)
  })

  test("returns non-JSON responses untouched", async () => {
    const response = new Response("bytes", {
      headers: { "content-type": "application/octet-stream" },
    })
    const result = await mirrorResponseToRequestHost({
      request: jsonRequest({ [MIRROR_REQUEST_HOST_HEADER]: "api.pirate" }),
      response,
      env,
    })
    expect(result).toBe(response)
  })

  test("rehosts nested canonical API URLs across every ref class", async () => {
    const payload = {
      items: [{
        post: {
          post: {
            media_refs: [{
              storage_ref: "https://api.pirate.sc/public-communities/cmt_x/song-artifact-uploads/sau_v/content",
              poster_ref: "https://api.pirate.sc/community-media/post_image/poster_y.jpg",
              preview_video: {
                storage_ref: "https://api.pirate.sc/public-communities/cmt_x/song-artifact-uploads/sau_p/content?preview=1#t=0",
              },
            }],
            song_cover_art_ref: "https://api.pirate.sc/communities/cmt_x/song-artifact-uploads/sau_c/content",
            song_presentation: {
              cover_art_ref: "https://api.pirate.sc/communities/cmt_x/song-artifact-uploads/sau_c/content",
              downloadable_audio: [{
                kind: "original",
                storage_ref: "https://api.pirate.sc/communities/cmt_x/song-artifact-uploads/sau_a/content",
              }],
            },
            link_url: "https://example.test/article",
            body: "see https://api.pirate.sc/communities/cmt_x for details",
          },
        },
        community: {
          avatar_ref: "https://api.pirate.sc/community-media/avatar/avatar_z.jpg",
          banner_ref: "https://api.pirate.sc/community-media/banner/banner_z.jpg",
        },
      }],
      next_cursor: null,
    }

    const result = await mirrorResponseToRequestHost({
      request: jsonRequest({ [MIRROR_REQUEST_HOST_HEADER]: "api.pirate" }),
      response: jsonResponse(payload),
      env,
    })

    expect(result).not.toBeNull()
    const body = await result.json() as typeof payload
    const post = body.items[0]!.post.post
    expect(post.media_refs[0]!.storage_ref).toBe(
      "https://api.pirate/public-communities/cmt_x/song-artifact-uploads/sau_v/content",
    )
    expect(post.media_refs[0]!.poster_ref).toBe("https://api.pirate/community-media/post_image/poster_y.jpg")
    expect(post.media_refs[0]!.preview_video.storage_ref).toBe(
      "https://api.pirate/public-communities/cmt_x/song-artifact-uploads/sau_p/content?preview=1#t=0",
    )
    expect(post.song_cover_art_ref).toBe("https://api.pirate/communities/cmt_x/song-artifact-uploads/sau_c/content")
    expect(post.song_presentation.cover_art_ref).toBe(
      "https://api.pirate/communities/cmt_x/song-artifact-uploads/sau_c/content",
    )
    expect(post.song_presentation.downloadable_audio[0]!.storage_ref).toBe(
      "https://api.pirate/communities/cmt_x/song-artifact-uploads/sau_a/content",
    )
    expect(body.items[0]!.community.avatar_ref).toBe("https://api.pirate/community-media/avatar/avatar_z.jpg")
    expect(body.items[0]!.community.banner_ref).toBe("https://api.pirate/community-media/banner/banner_z.jpg")

    // Non-API URLs and URLs embedded in free text are out of scope.
    expect(post.link_url).toBe("https://example.test/article")
    expect(post.body).toBe("see https://api.pirate.sc/communities/cmt_x for details")
  })

  test("leaves ipfs gateway, data URI, relative, and already-mirrored refs untouched", async () => {
    const payload = {
      refs: [
        "https://psc.myfilebase.com/ipfs/bafy123",
        "ipfs://bafy123",
        "data:image/svg+xml;charset=utf-8,%3Csvg%3E%3C/svg%3E",
        "/community-media/avatar/avatar_z.jpg",
        "https://api.pirate/community-media/avatar/avatar_z.jpg",
        "media://community-avatar",
        "https://user:pass@api.pirate.sc/community-media/avatar/avatar_z.jpg",
      ],
    }
    const result = await mirrorResponseToRequestHost({
      request: jsonRequest({ [MIRROR_REQUEST_HOST_HEADER]: "api.pirate" }),
      response: jsonResponse(payload),
      env,
    })
    // Nothing rewritable, so the original response object passes through.
    expect(await result.json()).toEqual(payload)
  })

  test("rehosts the configured public origin hostname as well", async () => {
    const response = jsonResponse({
      storage_ref: "https://pirate-api-staging.example.dev/community-media/avatar/avatar_z.jpg",
    })
    const result = await mirrorResponseToRequestHost({
      request: jsonRequest({ [MIRROR_REQUEST_HOST_HEADER]: "api.pirate" }),
      response,
      env: { PIRATE_API_PUBLIC_ORIGIN: "https://pirate-api-staging.example.dev" },
    })
    expect(await result.json()).toEqual({
      storage_ref: "https://api.pirate/community-media/avatar/avatar_z.jpg",
    })
  })

  test("marks mirrored responses uncacheable for shared caches and varies on the mirror header", async () => {
    const response = jsonResponse(
      { storage_ref: "https://api.pirate.sc/community-media/avatar/avatar_z.jpg" },
      {
        "cache-control": "public, max-age=0",
        "cdn-cache-control": "public, max-age=600, stale-while-revalidate=3600",
        "cloudflare-cdn-cache-control": "public, max-age=600, stale-while-revalidate=3600",
        "content-length": "123",
        "etag": "\"canonical\"",
        "vary": "Accept",
      },
    )
    const result = await mirrorResponseToRequestHost({
      request: jsonRequest({ [MIRROR_REQUEST_HOST_HEADER]: "api.pirate" }),
      response,
      env,
    })

    expect(result.headers.get("cloudflare-cdn-cache-control")).toBe("no-store")
    expect(result.headers.get("cdn-cache-control")).toBe("no-store")
    expect(result.headers.get("cache-control")).toBe("private, no-store")
    expect(result.headers.get("vary")).toBe(`Accept, ${MIRROR_REQUEST_HOST_HEADER}`)
    expect(result.headers.get("content-length")).toBeNull()
    expect(result.headers.get("etag")).toBeNull()
    expect(result.status).toBe(200)
  })

  test("passes through JSON responses with no canonical refs unchanged", async () => {
    const payload = { items: [], next_cursor: null }
    const response = jsonResponse(payload, {
      "cdn-cache-control": "public, max-age=600, stale-while-revalidate=3600",
    })
    const result = await mirrorResponseToRequestHost({
      request: jsonRequest({ [MIRROR_REQUEST_HOST_HEADER]: "api.pirate" }),
      response,
      env,
    })
    expect(result).toBe(response)
  })
})
