import { afterEach, describe, expect, test } from "bun:test"

import type { Env } from "../../env"
import { fetchSongArtifactBytes } from "./song-artifact-storage"

const originalFetch = globalThis.fetch

const env = {
  FILEBASE_S3_ACCESS_KEY: "test-access-key",
  FILEBASE_S3_SECRET_KEY: "test-secret-key",
  FILEBASE_MEDIA_BUCKET: "test-media",
  FILEBASE_S3_ENDPOINT: "https://s3.filebase.test",
  FILEBASE_S3_REGION: "auto",
} as Env

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("fetchSongArtifactBytes", () => {
  test("uses a host-only presign and forwards the exact caller-selected range", async () => {
    let observed: Request | null = null
    globalThis.fetch = async (request) => {
      observed = request instanceof Request ? request : new Request(request)
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 206,
        headers: {
          "accept-ranges": "bytes",
          "content-length": "3",
          "content-range": "bytes 7-9/20",
          "content-type": "audio/mpeg",
        },
      })
    }

    const response = await fetchSongArtifactBytes({
      env,
      objectKey: "song-artifacts/community/instrumental_audio/upload.mp3",
      rangeHeader: "bytes=7-9",
    })

    expect(response.status).toBe(206)
    expect(response.headers.get("content-range")).toBe("bytes 7-9/20")
    expect(observed).not.toBeNull()
    const upstream = observed!
    expect(upstream.headers.get("range")).toBe("bytes=7-9")
    expect(upstream.headers.get("authorization")).toBeNull()
    expect(new URL(upstream.url).searchParams.get("X-Amz-Signature")).toMatch(/^[a-f0-9]{64}$/)
    expect(new URL(upstream.url).searchParams.get("X-Amz-SignedHeaders")).toBe("host")
  })

  test("keeps ordinary full reads on header authentication", async () => {
    let observed: Request | null = null
    globalThis.fetch = async (request) => {
      observed = request instanceof Request ? request : new Request(request)
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: {
          "content-length": "3",
          "content-type": "audio/mpeg",
        },
      })
    }

    const response = await fetchSongArtifactBytes({
      env,
      objectKey: "song-artifacts/community/instrumental_audio/upload.mp3",
    })

    expect(response.status).toBe(200)
    expect(observed).not.toBeNull()
    const upstream = observed!
    expect(upstream.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /)
    expect(upstream.headers.get("range")).toBeNull()
    expect(new URL(upstream.url).searchParams.get("X-Amz-Signature")).toBeNull()
  })
})
