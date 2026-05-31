import { afterEach, describe, expect, test } from "bun:test"
import { syncSongBundleToAcrCloudCatalog } from "./song-artifact-catalog"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("syncSongBundleToAcrCloudCatalog", () => {
  test("uses the song bundle title for the catalog upload title and filename", async () => {
    const captured: { title?: FormDataEntryValue | null; filename?: string | null } = {}

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
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
    }

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
})
