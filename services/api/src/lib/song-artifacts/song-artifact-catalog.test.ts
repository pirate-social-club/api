import { afterEach, describe, expect, test } from "bun:test"
import { mockFetch } from "../../test-helpers/fetch"
import {
  syncSongBundleToAcrCloudCatalog,
  syncVideoAudioSampleToAcrCloudCatalog,
} from "./song-artifact-catalog"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("syncSongBundleToAcrCloudCatalog", () => {
  test("does not fetch song bytes when catalog configuration is missing", async () => {
    let fetchCalled = false
    globalThis.fetch = mockFetch(async () => {
      fetchCalled = true
      throw new Error("unexpected fetch")
    })

    const result = await syncSongBundleToAcrCloudCatalog({
      env: {} as any,
      communityId: "community_123",
      songArtifactBundleId: "bundle_123",
      bundle: {
        primary_audio: {
          storage_ref: "https://storage.test/song.mp3",
          mime_type: "audio/mpeg",
        },
      } as any,
    })

    expect(result).toMatchObject({
      attempted: false,
      synced: false,
      error: "missing_configuration",
    })
    expect(fetchCalled).toBe(false)
  })

  test("uses the song bundle title for the catalog upload title and filename", async () => {
    const captured: { title?: FormDataEntryValue | null; filename?: string | null } = {}

    globalThis.fetch = mockFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === "https://storage.test/song.mp3") {
        return new Response(new Uint8Array([1, 2, 3]), {
          headers: { "content-type": "audio/mpeg" },
        })
      }

      const body = init?.body
      if (!(body instanceof FormData)) {
        throw new Error("expected ACRCloud catalog request body to be FormData")
      }
      const file = body.get("file")
      captured.title = body.get("title")
      captured.filename = file instanceof File ? file.name : null

      return new Response(JSON.stringify({
        data: {
          id: "file_123",
          acr_id: "acr_123",
          state: 1,
        },
      }), {
        headers: { "content-type": "application/json" },
      })
    })

    const result = await syncSongBundleToAcrCloudCatalog({
      env: {
        ACRCLOUD_BUCKET_ID: "30358",
        ACRCLOUD_CONSOLE_BASE_URL: "https://console-v2.acrcloud.test/api",
        ACRCLOUD_PERSONAL_ACCESS_TOKEN: "test-token",
      } as any,
      communityId: "community_123",
      songArtifactBundleId: "bundle_123",
      bundle: {
        title: "Midnight Demo",
        lyrics_sha256: null,
        primary_audio: {
          storage_ref: "https://storage.test/song.mp3",
          mime_type: "audio/mpeg",
          content_hash: "0xabc123",
        },
      } as any,
    })

    expect(result.synced).toBe(true)
    expect(captured.title).toBe("Midnight Demo")
    expect(captured.filename).toBe("Midnight Demo.mp3")
  })

  test("tags video audio enrollment as an identity-only catalog entry", async () => {
    let userDefined: Record<string, unknown> | null = null

    globalThis.fetch = mockFetch(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body
      if (!(body instanceof FormData)) {
        throw new Error("expected ACRCloud catalog request body to be FormData")
      }
      userDefined = JSON.parse(String(body.get("user_defined"))) as Record<string, unknown>
      return new Response(JSON.stringify({
        data: { id: "file_video_123", acr_id: "acr_video_123", state: 1 },
      }), {
        headers: { "content-type": "application/json" },
      })
    })

    const result = await syncVideoAudioSampleToAcrCloudCatalog({
      env: {
        ACRCLOUD_BUCKET_ID: "30358",
        ACRCLOUD_CONSOLE_BASE_URL: "https://console-v2.acrcloud.test/api",
        ACRCLOUD_PERSONAL_ACCESS_TOKEN: "test-token",
      } as any,
      sampleBytes: new Uint8Array([1, 2, 3]),
      communityId: "community_123",
      postId: "post_123",
      assetId: "asset_123",
      uploaderUserId: "user_123",
      sampleWindow: { start_ms: 6_000, duration_ms: 24_000 },
    })

    expect(result.synced).toBe(true)
    expect(userDefined).toEqual({
      source: "pirate",
      content_type: "video_audio",
      post_id: "post_123",
      asset_id: "asset_123",
      community_id: "community_123",
      uploader: "user_123",
      sample_window: { start_ms: 6_000, duration_ms: 24_000 },
    })
  })
})
